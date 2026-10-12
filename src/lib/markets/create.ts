/**
 * Creating a market, paid and signed by the oracle (the memestream server key): the MetaDAO
 * question + wSOL vault, then seed liquidity — SOL split into YES + NO, and one DAMM v2 pool per side
 * starting at 0.5 SOL per token. Up to four transactions, sent in order (each fits a legacy
 * transaction). Steps already on chain are skipped, so a create cut short can be run again.
 * Names for the YES/NO mints are a separate, optional transaction (buildMarketMetadataTx).
 */
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { type Connection, Keypair, type PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { built, type BuiltTx } from "../dbc/tx";
import type { Side } from "./math";
import { ACTIVATION_TYPE, COLLECT_FEE_MODE, type MarketKeys, marketPoolFees, PRICE_RANGE, seedPlan, type SeedPlan } from "./pool";
import { fetchQuestion, initializeMarketIxs, metadataIxs, splitIxs } from "./vault";

export type TokenNames = Record<Side, { name: string; symbol: string; uri: string }>;

/** Moves `lamports` SOL into `owner`'s wrapped-SOL account (created if missing). */
export function wrapSolIxs(owner: PublicKey, lamports: BN): TransactionInstruction[] {
  const account = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, account, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: account, lamports: BigInt(lamports.toString()) }),
    createSyncNativeInstruction(account),
  ];
}

/** Closes `owner`'s wrapped-SOL account: its wSOL and rent come back as plain SOL. */
export const unwrapSolIx = (owner: PublicKey) => createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, owner), owner, owner);

async function poolTx(connection: Connection, keys: MarketKeys, side: Side, plan: SeedPlan): Promise<BuiltTx> {
  const positionNft = Keypair.generate();
  const { tx } = await new CpAmm(connection).createCustomPool({
    payer: keys.oracle,
    creator: keys.oracle,
    positionNft: positionNft.publicKey,
    tokenAMint: keys.mints[side],
    tokenBMint: NATIVE_MINT,
    tokenAAmount: plan.outcomeTokens,
    tokenBAmount: plan.lamportsPerPool,
    sqrtMinPrice: PRICE_RANGE.min,
    sqrtMaxPrice: PRICE_RANGE.max,
    initSqrtPrice: PRICE_RANGE.start,
    liquidityDelta: plan.liquidity,
    poolFees: marketPoolFees(),
    hasAlphaVault: false,
    activationType: ACTIVATION_TYPE,
    collectFeeMode: COLLECT_FEE_MODE,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: false,
  });
  // The SDK wraps exactly the seed; any rounding dust and the account's rent come back here.
  tx.add(unwrapSolIx(keys.oracle));
  return built(tx, keys.oracle, [positionNft]);
}

/** Token account amount (u64 @64), or 0 if the account doesn't exist. */
const tokenAmount = (data: Buffer | undefined) => new BN(data && data.length >= 72 ? data.readBigUInt64LE(64).toString() : "0");

/**
 * The market's transactions still to send, in order. `lamportsPerPool` is the SOL on each pool's
 * wSOL side; the oracle also splits ~0.61× that into YES + NO for the pools' token side (only what
 * it doesn't hold already for a pool still missing).
 */
export async function buildCreateMarketTxs(connection: Connection, keys: MarketKeys, lamportsPerPool: BN): Promise<BuiltTx[]> {
  const plan = seedPlan(lamportsPerPool);
  const { oracle } = keys;
  const sides: Side[] = ["yes", "no"];
  const outcomeAccounts = sides.map((side) => getAssociatedTokenAddressSync(keys.mints[side], oracle));
  const [question, infos] = await Promise.all([
    fetchQuestion(connection, keys.question),
    connection.getMultipleAccountsInfo([keys.pools.yes, keys.pools.no, ...outcomeAccounts]),
  ]);
  const missing = sides.filter((_, i) => !infos[i]);
  const held = sides.map((_, i) => tokenAmount(infos[2 + i]?.data));
  const short = missing.map((side) => BN.max(plan.outcomeTokens.sub(held[sides.indexOf(side)]), new BN(0))).reduce((a, b) => BN.max(a, b), new BN(0));

  const txs: BuiltTx[] = [];
  if (!question) txs.push(built(new Transaction().add(...(await initializeMarketIxs(connection, keys.questionId, oracle, oracle))), oracle));
  if (!short.isZero()) {
    const split = new Transaction().add(...wrapSolIxs(oracle, short), ...(await splitIxs(connection, keys, oracle, short)), unwrapSolIx(oracle));
    txs.push(built(split, oracle));
  }
  for (const side of missing) txs.push(await poolTx(connection, keys, side, plan));
  return txs;
}

/** Names the YES/NO mints (optional; see metadataIxs). */
export async function buildMarketMetadataTx(connection: Connection, keys: MarketKeys, names: TokenNames): Promise<BuiltTx> {
  return built(new Transaction().add(...(await metadataIxs(connection, keys, keys.oracle, names))), keys.oracle);
}
