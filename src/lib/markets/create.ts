/**
 * Creating a market, paid and signed by the oracle (the memestream server key): the MetaDAO
 * question + wSOL vault, then the seed — S SOL split into S YES + S NO, both deposited in one DAMM v2
 * YES/NO pool at 1:1. Up to three transactions, sent in order (each fits a legacy transaction).
 * Steps already on chain are skipped, so a create cut short can be run again.
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
import { type Connection, type Keypair, type PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
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

/** The YES/NO pool, seeded with the plan's YES and NO at 1:1, its position made with `positionNft`. */
async function poolTx(connection: Connection, keys: MarketKeys, plan: SeedPlan, positionNft: Keypair): Promise<BuiltTx> {
  const { tx } = await new CpAmm(connection).createCustomPool({
    payer: keys.oracle,
    creator: keys.oracle,
    positionNft: positionNft.publicKey,
    tokenAMint: keys.mints.yes,
    tokenBMint: keys.mints.no,
    tokenAAmount: plan.yes,
    tokenBAmount: plan.no,
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
  return built(tx, keys.oracle, [positionNft]);
}

/** Token account amount (u64 @64), or 0 if the account doesn't exist. */
const tokenAmount = (data: Buffer | undefined) => new BN(data && data.length >= 72 ? data.readBigUInt64LE(64).toString() : "0");

/**
 * The market's transactions still to send, in order: the question and vault, the split of `lamports`
 * SOL into YES + NO (only what the oracle doesn't hold already), and the YES/NO pool. The pool is
 * created with `positionNft` (provenance.ts), which is how the server later tells its pool from others'.
 */
export async function buildCreateMarketTxs(connection: Connection, keys: MarketKeys, lamports: BN, positionNft: Keypair): Promise<BuiltTx[]> {
  const plan = seedPlan(lamports);
  const { oracle } = keys;
  const sides: Side[] = ["yes", "no"];
  const [question, infos] = await Promise.all([
    fetchQuestion(connection, keys.question),
    connection.getMultipleAccountsInfo([keys.pool, ...sides.map((side) => getAssociatedTokenAddressSync(keys.mints[side], oracle))]),
  ]);
  const txs: BuiltTx[] = [];
  if (!question) txs.push(built(new Transaction().add(...(await initializeMarketIxs(connection, keys.questionId, oracle, oracle))), oracle));
  if (infos[0]) return txs;
  const short = BN.max(BN.max(plan.yes.sub(tokenAmount(infos[1]?.data)), plan.no.sub(tokenAmount(infos[2]?.data))), new BN(0));
  if (!short.isZero()) {
    const split = new Transaction().add(...wrapSolIxs(oracle, short), ...(await splitIxs(connection, keys, oracle, short)), unwrapSolIx(oracle));
    txs.push(built(split, oracle));
  }
  txs.push(await poolTx(connection, keys, plan, positionNft));
  return txs;
}

/** Names the YES/NO mints (optional; see metadataIxs). */
export async function buildMarketMetadataTx(connection: Connection, keys: MarketKeys, names: TokenNames): Promise<BuiltTx> {
  return built(new Transaction().add(...(await metadataIxs(connection, keys, keys.oracle, names))), keys.oracle);
}
