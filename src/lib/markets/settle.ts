/**
 * Ending a market: the oracle closes trading (takes its liquidity out of the pool), resolves the
 * question, and then every holder — the oracle too, for the tokens its liquidity came back as —
 * redeems YES/NO for SOL.
 *
 * Closing trading: the oracle's position is the pool's liquidity, so removing it leaves the pool
 * (nearly) empty. Anyone can add a little back, so the server never judges "open" from liquidity: it
 * refuses bets from the prediction's lockAt (server/markets.ts). Before resolution a holder of both
 * sides can still merge YES + NO back into SOL (vault.ts).
 */
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { type Connection, type PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { InputError } from "../dbc/errors";
import { built, type BuiltTx } from "../dbc/tx";
import { lpPositionsOf } from "../damm/positions";
import { type Outcome, payoutNumerators, type Side } from "./math";
import type { MarketKeys, MarketPool } from "./pool";
import { unwrapSolIx } from "./create";
import { fetchQuestion, redeemIxs, resolveIx } from "./vault";

const SIDES: Side[] = ["yes", "no"];
export const CLOSE_SLIPPAGE_BPS = 100;
const atLeast = (amount: BN) => amount.muln(10_000 - CLOSE_SLIPPAGE_BPS).divn(10_000);

/**
 * One transaction per position the oracle still has in the market's pool: claims its fees, removes
 * all liquidity and closes the position (its rent comes back). The oracle gets YES + NO back, which
 * it redeems after resolution. Minimums come from a fresh withdraw quote, less CLOSE_SLIPPAGE_BPS: a
 * price pushed around between the quote and the close makes the close fail (and the server tries
 * again) rather than fill worse.
 */
export async function buildCloseTradingTxs(connection: Connection, keys: MarketKeys, pool: MarketPool): Promise<BuiltTx[]> {
  const cpAmm = new CpAmm(connection);
  const txs: BuiltTx[] = [];
  for (const p of await lpPositionsOf(connection, pool.address, keys.oracle)) {
    const quote = cpAmm.getWithdrawQuote({
      liquidityDelta: p.positionState.unlockedLiquidity,
      minSqrtPrice: pool.state.sqrtMinPrice,
      maxSqrtPrice: pool.state.sqrtMaxPrice,
      sqrtPrice: pool.state.sqrtPrice,
      collectFeeMode: pool.state.collectFeeMode,
      tokenAAmount: pool.state.tokenAAmount,
      tokenBAmount: pool.state.tokenBAmount,
      liquidity: pool.state.liquidity,
    });
    const tx = await cpAmm.removeAllLiquidityAndClosePosition({
      owner: keys.oracle,
      position: p.position,
      positionNftAccount: p.positionNftAccount,
      poolState: pool.state,
      positionState: p.positionState,
      tokenAAmountThreshold: atLeast(quote.outAmountA),
      tokenBAmountThreshold: atLeast(quote.outAmountB),
      vestings: [],
      currentPoint: pool.currentPoint,
    });
    txs.push(built(tx, keys.oracle));
  }
  return txs;
}

/** Oracle only, once: YES [1,0], NO [0,1], or a refund [1,1] when disputed or cancelled. */
export async function buildResolveTx(connection: Connection, keys: MarketKeys, outcome: Outcome): Promise<BuiltTx> {
  const question = await fetchQuestion(connection, keys.question);
  if (!question) throw new InputError("No market for this prediction");
  if (question.resolved) throw new InputError("This market is already resolved");
  return built(new Transaction().add(await resolveIx(connection, keys.question, keys.oracle, payoutNumerators(outcome))), keys.oracle);
}

/**
 * Burns all the holder's YES and NO for their share of SOL, closes the emptied token accounts
 * (their rent comes back) and unwraps the payout, all in one transaction. A losing side pays 0 but
 * is still burned, so the wallet ends clean.
 */
export async function buildRedeemTx(connection: Connection, keys: MarketKeys, holder: PublicKey): Promise<BuiltTx> {
  const question = await fetchQuestion(connection, keys.question);
  if (!question) throw new InputError("No market for this prediction");
  if (!question.resolved) throw new InputError("This prediction isn't resolved yet");
  const accounts = SIDES.map((side) => getAssociatedTokenAddressSync(keys.mints[side], holder));
  const infos = await connection.getMultipleAccountsInfo(accounts);
  // Token account: amount u64 @64.
  const held = infos.some((info) => info && info.data.length >= 72 && info.data.readBigUInt64LE(64) > BigInt(0));
  if (!held) throw new InputError("This wallet holds no YES or NO tokens for this prediction");
  const tx = new Transaction().add(
    // The wrapped-SOL account the payout lands in.
    createAssociatedTokenAccountIdempotentInstruction(holder, getAssociatedTokenAddressSync(NATIVE_MINT, holder), holder, NATIVE_MINT),
    ...(await redeemIxs(connection, keys, holder)),
    ...accounts.map((account) => createCloseAccountInstruction(account, holder, holder)),
    unwrapSolIx(holder),
  );
  return built(tx, holder);
}
