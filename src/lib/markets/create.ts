/**
 * Creating a market, paid and signed by the oracle (the memestream server key): the MetaDAO
 * question + wSOL vault, then seed liquidity — SOL split into YES + NO, and one DAMM v2 pool per side
 * starting at 0.5 SOL per token. Four transactions, sent in order (each fits a legacy transaction).
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
import type BN from "bn.js";
import { built, type BuiltTx } from "../dbc/tx";
import type { Side } from "./math";
import { ACTIVATION_TYPE, COLLECT_FEE_MODE, type MarketKeys, marketPoolFees, PRICE_RANGE, seedPlan, type SeedPlan } from "./pool";
import { initializeMarketIxs, splitIxs } from "./vault";

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

/**
 * The market's transactions, in send order. `lamportsPerPool` is the SOL on each pool's wSOL side;
 * the oracle also splits ~0.61× that into YES + NO for the pools' token side.
 */
export async function buildCreateMarketTxs(connection: Connection, keys: MarketKeys, names: TokenNames, lamportsPerPool: BN): Promise<BuiltTx[]> {
  const plan = seedPlan(lamportsPerPool);
  const { oracle } = keys;
  const init = new Transaction().add(...(await initializeMarketIxs(connection, keys.questionId, oracle, oracle, names)));
  const split = new Transaction().add(
    ...wrapSolIxs(oracle, plan.outcomeTokens),
    ...(await splitIxs(connection, keys, oracle, plan.outcomeTokens)),
    unwrapSolIx(oracle),
  );
  return [built(init, oracle), built(split, oracle), await poolTx(connection, keys, "yes", plan), await poolTx(connection, keys, "no", plan)];
}
