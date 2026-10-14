/**
 * memestream's own earnings on the shared config (DBC "partner"), claimed by the config's
 * feeClaimer wallet:
 * - its share of curve trading fees (20%; the streamer gets 80%), per pool, in SOL;
 * - the launch fee per coin (poolCreationFee, less Meteora's 10% protocol share).
 * One transaction claims several pools; claims are packed until the next one wouldn't fit.
 * Fee payer and only signer: the fee claimer. Nothing here signs or sends.
 */
import {
  deriveDbcPoolAuthority,
  type DynamicBondingCurveClient,
  getTokenProgram,
  type PoolConfig,
  PROTOCOL_POOL_CREATION_FEE_PERCENT,
  U64_MAX,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import { ComputeBudgetProgram, type PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { InputError } from "./errors";
import { type BuiltTx, built } from "./tx";

/**
 * Set in a pool's `creationFeeBits` once the partner claimed its launch fee. Read off the real
 * program (test/integration/partner-fees.surfpool.ts): a claim sets 0b10 and a second one fails.
 */
export const PARTNER_CLAIMED_LAUNCH_FEE = 0b10;

/** Trading fees below this (lamports) aren't worth a claim instruction. */
export const MIN_TRADING_CLAIM_LAMPORTS = new BN(100_000);

/** The most a legacy transaction can be, in bytes. */
const MAX_TX_BYTES = 1232;
const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";

export type PartnerFeePool = {
  pool: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  /** Unclaimed partner share of trading fees. */
  tradingLamports: BN;
  /** The launch fee still to claim (0 once claimed, or on a free config). */
  launchFeeLamports: BN;
};

export type PartnerFees = {
  config: PublicKey;
  configState: PoolConfig;
  feeClaimer: PublicKey;
  /** Only pools with something to claim. */
  pools: PartnerFeePool[];
  totalLamports: BN;
  /** Every pool on the config, claimable or not. */
  poolCount: number;
};

/** The partner's share of one launch fee (Meteora keeps PROTOCOL_POOL_CREATION_FEE_PERCENT). */
export const partnerLaunchFee = (config: Pick<PoolConfig, "poolCreationFee">): BN =>
  config.poolCreationFee.muln(100 - PROTOCOL_POOL_CREATION_FEE_PERCENT).divn(100);

/** What the fee claimer can claim now. Reads every pool on the config (one getProgramAccounts). */
export async function loadPartnerFees(client: DynamicBondingCurveClient, config: PublicKey): Promise<PartnerFees> {
  const configState = await client.state.getPoolConfig(config);
  if (!configState) throw new InputError(`Config not found: ${config.toBase58()}`);
  // The claim wraps and unwraps SOL; a config priced in another token needs other instructions.
  if (!configState.quoteMint.equals(NATIVE_MINT)) throw new InputError("Partner claims support SOL-priced configs only");
  const launchFee = partnerLaunchFee(configState);
  const all = await client.state.getPoolsByConfig(config);
  const pools: PartnerFeePool[] = [];
  for (const { publicKey, account: { poolState: account } } of all) {
    const tradingLamports = account.partnerQuoteFee.gte(MIN_TRADING_CLAIM_LAMPORTS) ? account.partnerQuoteFee : new BN(0);
    const launchFeeLamports = account.creationFeeBits & PARTNER_CLAIMED_LAUNCH_FEE ? new BN(0) : launchFee;
    if (tradingLamports.isZero() && launchFeeLamports.isZero()) continue;
    pools.push({ pool: publicKey, baseMint: account.baseMint, baseVault: account.baseVault, quoteVault: account.quoteVault, tradingLamports, launchFeeLamports });
  }
  const totalLamports = pools.reduce((sum, p) => sum.add(p.tradingLamports).add(p.launchFeeLamports), new BN(0));
  return { config, configState, feeClaimer: configState.feeClaimer, pools, totalLamports, poolCount: all.length };
}

/**
 * The instructions to claim one pool's partner fees. The program pays trading fees into token
 * accounts, so the coin's account is created (the SDK does the same) and, if it didn't exist
 * before, closed again in the same transaction: no rent is left behind. Fees are SOL only, so the
 * coin account always ends empty.
 */
async function claimInstructions(client: DynamicBondingCurveClient, fees: PartnerFees, pool: PartnerFeePool, hadCoinAccount: boolean): Promise<TransactionInstruction[]> {
  const { configState, feeClaimer, config } = fees;
  const baseProgram = getTokenProgram(configState.tokenType);
  const quoteProgram = getTokenProgram(configState.quoteTokenFlag);
  const coinAccount = getAssociatedTokenAddressSync(pool.baseMint, feeClaimer, true, baseProgram);
  const program = client.partner.program;
  const out: TransactionInstruction[] = [];
  if (!pool.tradingLamports.isZero()) {
    out.push(
      createAssociatedTokenAccountIdempotentInstruction(feeClaimer, coinAccount, feeClaimer, pool.baseMint, baseProgram),
      await program.methods
        .claimTradingFee(new BN(0), U64_MAX)
        .accountsPartial({
          poolAuthority: deriveDbcPoolAuthority(),
          config,
          pool: pool.pool,
          tokenAAccount: coinAccount,
          tokenBAccount: getAssociatedTokenAddressSync(configState.quoteMint, feeClaimer, true, quoteProgram),
          baseVault: pool.baseVault,
          quoteVault: pool.quoteVault,
          baseMint: pool.baseMint,
          quoteMint: configState.quoteMint,
          feeClaimer,
          tokenBaseProgram: baseProgram,
          tokenQuoteProgram: quoteProgram,
        })
        .instruction(),
    );
    if (!hadCoinAccount) out.push(createCloseAccountInstruction(coinAccount, feeClaimer, feeClaimer, [], baseProgram));
  }
  if (!pool.launchFeeLamports.isZero()) {
    out.push(await program.methods.claimPartnerPoolCreationFee().accountsPartial({ config, pool: pool.pool, feeClaimer, feeReceiver: feeClaimer }).instruction());
  }
  return out;
}

/** A transaction with the given claims, wrapped in the SOL account open/unwrap when it claims trading fees. */
function claimTx(fees: PartnerFees, groups: { trading: boolean; ixs: TransactionInstruction[] }[]): Transaction {
  const { configState, feeClaimer } = fees;
  const quoteProgram = getTokenProgram(configState.quoteTokenFlag);
  const solAccount = getAssociatedTokenAddressSync(configState.quoteMint, feeClaimer, true, quoteProgram);
  const trading = groups.some((g) => g.trading);
  // Room for the priority fee the caller adds (two Compute Budget instructions).
  const tx = new Transaction({ feePayer: feeClaimer, recentBlockhash: PLACEHOLDER_BLOCKHASH }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 0 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
  );
  if (trading) tx.add(createAssociatedTokenAccountIdempotentInstruction(feeClaimer, solAccount, feeClaimer, configState.quoteMint, quoteProgram));
  for (const g of groups) tx.add(...g.ixs);
  if (trading) tx.add(createCloseAccountInstruction(solAccount, feeClaimer, feeClaimer, [], quoteProgram));
  return tx;
}

/** web3.js throws on an oversized transaction, so a throw means "doesn't fit". */
function fits(tx: Transaction): boolean {
  try {
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= MAX_TX_BYTES;
  } catch {
    return false;
  }
}

/**
 * Unsigned claim transactions for everything in `fees`, at most `maxTxs` of them (the rest wait
 * for the next run). Only the config's fee claimer can sign them.
 */
export async function buildPartnerClaimTxs(client: DynamicBondingCurveClient, fees: PartnerFees, claimer: PublicKey, maxTxs = Infinity): Promise<BuiltTx[]> {
  if (!claimer.equals(fees.feeClaimer)) throw new InputError("Only the config's fee claimer can claim partner fees");
  if (fees.pools.length === 0) return [];
  const { configState, feeClaimer } = fees;
  const baseProgram = getTokenProgram(configState.tokenType);
  const coinAccounts = fees.pools.map((p) => getAssociatedTokenAddressSync(p.baseMint, feeClaimer, true, baseProgram));
  const existing = await client.connection.getMultipleAccountsInfo(coinAccounts);

  const txs: Transaction[] = [];
  let current: { trading: boolean; ixs: TransactionInstruction[] }[] = [];
  for (const [i, pool] of fees.pools.entries()) {
    if (txs.length >= maxTxs) break;
    const group = { trading: !pool.tradingLamports.isZero(), ixs: await claimInstructions(client, fees, pool, existing[i] !== null) };
    if (current.length && !fits(claimTx(fees, [...current, group]))) {
      txs.push(claimTx(fees, current));
      current = [];
      if (txs.length >= maxTxs) break;
    }
    current.push(group);
  }
  if (current.length && txs.length < maxTxs) txs.push(claimTx(fees, current));
  return txs.map((tx) => {
    // Drop the placeholders: the caller sets the real blockhash and priority fee.
    tx.instructions = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
    tx.recentBlockhash = undefined;
    return built(tx, feeClaimer);
  });
}
