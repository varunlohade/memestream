/**
 * Betting, the way a Gnosis FPMM does it, on the market's one YES/NO pool (pool.ts):
 * - BUY side X with A SOL, in one transaction: wrap A SOL, split it into A YES + A NO, swap all A of
 *   the other side into X, keep A + what the swap gave. Shares are minted on demand, so any size fills;
 *   only the price moves.
 * - SELL N shares of X: swap k of them into the other side so the swap gives back exactly N - k, merge
 *   those N - k pairs into N - k wSOL and unwrap it. k comes from a binary search on the pool's own
 *   quote; whatever the swap gives above its minimum stays with the seller as dust.
 * Every amount is checked against a fresh quote with a slippage cap, and the minimum the user saw is
 * a floor (the same money rules as the coin trades). Every destination is the trader's own account.
 */
import { CpAmm, getTokenProgram, PriceRangeViolationError, SwapMode, swapQuoteExactInput } from "@meteora-ag/cp-amm-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { type Connection, type PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { InputError } from "../dbc/errors";
import { MAX_SLIPPAGE_BPS } from "../dbc/trade";
import { built, type BuiltTx } from "../dbc/tx";
import { unwrapSolIx, wrapSolIxs } from "./create";
import type { Side } from "./math";
import { type MarketKeys, type MarketPool, OUTCOME_DECIMALS, yesProbability } from "./pool";
import { mergeIxs, splitIxs } from "./vault";

/** buy: SOL in (lamports); sell: shares of `side` in (9 decimals, like SOL). */
export type MarketOrder = { side: Side; action: "buy" | "sell"; amount: BN };

export type MarketQuote = {
  /** What goes in: SOL for a buy, shares for a sell. */
  spentAmount: BN;
  /** What comes out: shares for a buy, SOL for a sell. */
  outputAmount: BN;
  /** The least that can come out; the transaction fails rather than give less. Never zero. */
  minimumAmountOut: BN;
  /** The swap inside: how much goes in, and the least it may give. */
  swap: { amountIn: BN; minimumAmountOut: BN };
  /** SOL per share, on average, for this trade. */
  averagePrice: number;
  /** The probability of `side` before and after the trade. */
  probabilityBefore: number;
  probabilityAfter: number;
};

const OTHER: Record<Side, Side> = { yes: "no", no: "yes" };
/** The pool's token A is YES: selling YES into it swaps A to B. */
const aToB = (input: Side) => input === "yes";
const sideProbability = (side: Side, sqrtPrice: BN) => (side === "yes" ? yesProbability(sqrtPrice) : 1 - yesProbability(sqrtPrice));
/** Binary-search steps for a sell: enough to pin k to a lamport for any u64 amount. */
const SELL_SEARCH_STEPS = 70;

function checkSlippage(slippageBps: number) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw new InputError(`Slippage must be 0 to ${MAX_SLIPPAGE_BPS} bps`);
}

/** The pool's quote for swapping `amountIn` of `input` into the other side. */
function swapQuote(pool: MarketPool, input: Side, amountIn: BN, slippageBps: number) {
  try {
    const q = swapQuoteExactInput(pool.state, pool.currentPoint, amountIn, slippageBps, aToB(input), false, OUTCOME_DECIMALS, OUTCOME_DECIMALS);
    return { outputAmount: q.outputAmount, minimumAmountOut: q.minimumAmountOut ?? new BN(0), nextSqrtPrice: q.nextSqrtPrice };
  } catch (error) {
    // Only at the very ends of the range (about 0.1% or 99.9%): the pool has no more of that side.
    if (error instanceof PriceRangeViolationError) throw new InputError("This market is at its limit on that side. Try a smaller amount.");
    throw error;
  }
}

function buyQuote(pool: MarketPool, order: MarketOrder, slippageBps: number): MarketQuote {
  const { side, amount } = order;
  const swap = swapQuote(pool, OTHER[side], amount, slippageBps);
  const outputAmount = amount.add(swap.outputAmount);
  return {
    spentAmount: amount,
    outputAmount,
    minimumAmountOut: amount.add(swap.minimumAmountOut),
    swap: { amountIn: amount, minimumAmountOut: swap.minimumAmountOut },
    averagePrice: Number(amount.toString()) / Number(outputAmount.toString()),
    probabilityBefore: sideProbability(side, pool.state.sqrtPrice),
    probabilityAfter: sideProbability(side, swap.nextSqrtPrice),
  };
}

/** The smallest k whose swap minimum covers the N - k other-side shares to merge. */
function sellQuote(pool: MarketPool, order: MarketOrder, slippageBps: number): MarketQuote {
  const { side, amount: n } = order;
  const covers = (k: BN) => swapQuote(pool, side, k, slippageBps).minimumAmountOut.gte(n.sub(k));
  if (!covers(n)) throw new InputError("This market is at its limit on that side. Try a smaller amount.");
  let lo = new BN(0);
  let hi = n.clone();
  for (let i = 0; i < SELL_SEARCH_STEPS && hi.sub(lo).gtn(1); i++) {
    const mid = lo.add(hi).divn(2);
    if (covers(mid)) hi = mid;
    else lo = mid;
  }
  const k = covers(lo) ? lo : hi;
  const merged = n.sub(k);
  if (merged.isZero()) throw new InputError("Amount too small: you would get nothing back");
  const swap = swapQuote(pool, side, k, slippageBps);
  return {
    spentAmount: n,
    outputAmount: merged,
    minimumAmountOut: merged,
    swap: { amountIn: k, minimumAmountOut: merged },
    averagePrice: Number(merged.toString()) / Number(n.toString()),
    probabilityBefore: sideProbability(side, pool.state.sqrtPrice),
    probabilityAfter: sideProbability(side, swap.nextSqrtPrice),
  };
}

export function quoteMarketTrade(pool: MarketPool, order: MarketOrder, slippageBps: number): MarketQuote {
  checkSlippage(slippageBps);
  if (order.amount.lten(0)) throw new InputError("Amount must be more than 0");
  const quote = order.action === "buy" ? buyQuote(pool, order, slippageBps) : sellQuote(pool, order, slippageBps);
  if (quote.minimumAmountOut.isZero()) throw new InputError("Amount too small: you would get nothing back");
  return quote;
}

/** The pool swap inside a bet, as plain instructions: `amountIn` of `input` in, at least `minimumAmountOut` out. */
async function swapIxs(connection: Connection, pool: MarketPool, trader: PublicKey, input: Side, amountIn: BN, minimumAmountOut: BN) {
  const { state } = pool;
  const tx = await new CpAmm(connection).swap2({
    payer: trader,
    pool: pool.address,
    inputTokenMint: input === "yes" ? state.tokenAMint : state.tokenBMint,
    outputTokenMint: input === "yes" ? state.tokenBMint : state.tokenAMint,
    tokenAMint: state.tokenAMint,
    tokenBMint: state.tokenBMint,
    tokenAVault: state.tokenAVault,
    tokenBVault: state.tokenBVault,
    tokenAProgram: getTokenProgram(state.tokenAFlag),
    tokenBProgram: getTokenProgram(state.tokenBFlag),
    referralTokenAccount: null,
    poolState: state,
    swapMode: SwapMode.ExactIn,
    amountIn,
    minimumAmountOut,
  });
  return tx.instructions;
}

/**
 * Quotes and builds a bet in one transaction for `trader` (its only signer and every destination).
 * `atLeast` is the minimum the user saw: for a buy the swap's minimum rises to match it; a sell's
 * SOL out is fixed by its merge, so a floor above it fails before reaching the chain.
 */
export async function prepareMarketTrade(
  connection: Connection,
  keys: MarketKeys,
  pool: MarketPool,
  trader: PublicKey,
  order: MarketOrder,
  slippageBps: number,
  atLeast?: BN,
): Promise<BuiltTx & { quote: MarketQuote }> {
  const quote = quoteMarketTrade(pool, order, slippageBps);
  const { side, amount } = order;
  const tx = new Transaction();
  if (order.action === "buy") {
    const swapMin = atLeast?.gt(quote.minimumAmountOut) ? atLeast.sub(amount) : quote.swap.minimumAmountOut;
    tx.add(
      ...wrapSolIxs(trader, amount),
      ...(await splitIxs(connection, keys, trader, amount)),
      ...(await swapIxs(connection, pool, trader, OTHER[side], amount, swapMin)),
      unwrapSolIx(trader),
    );
    return { ...built(tx, trader), quote: { ...quote, minimumAmountOut: amount.add(swapMin) } };
  }
  if (atLeast?.gt(quote.outputAmount)) throw new InputError("The price moved. Check the new amount and try again.");
  tx.add(
    ...(await swapIxs(connection, pool, trader, side, quote.swap.amountIn, quote.swap.minimumAmountOut)),
    // The merge pays into the trader's wrapped-SOL account, made here if missing; unwrapped right after.
    createAssociatedTokenAccountIdempotentInstruction(trader, getAssociatedTokenAddressSync(NATIVE_MINT, trader), trader, NATIVE_MINT),
    ...(await mergeIxs(connection, keys, trader, quote.outputAmount)),
    unwrapSolIx(trader),
  );
  return { ...built(tx, trader), quote };
}
