/**
 * Betting: buying YES or NO with SOL, and selling them back for SOL, in that side's DAMM v2 pool.
 * The same money rules as a graduated coin (lib/damm/trade.ts, reused as is): exact-in swaps, a
 * slippage cap, a minimum that's never zero, and the minimum the user saw as a floor. The pool SDK
 * wraps SOL going in and unwraps SOL coming out, so the wallet only ever sees SOL.
 */
import { PriceRangeViolationError } from "@meteora-ag/cp-amm-sdk";
import type { Connection, PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import { InputError } from "../dbc/errors";
import type { TradeInput } from "../dbc/trade";
import type { DammSnapshot } from "../damm/pool";
import { type DammQuote, prepareDammTrade, quoteDammTrade } from "../damm/trade";
import type { BuiltTx } from "../dbc/tx";
import type { Side } from "./math";
import type { MarketPools } from "./pool";

/** buy: SOL in (lamports); sell: outcome tokens in (9 decimals, like SOL). */
export type MarketOrder = { side: Side; action: "buy" | "sell"; amount: BN };

/** The trade-box input the DAMM builder takes: "buy" spends SOL for token A, "sell" the reverse. */
const tradeInput = (order: MarketOrder): TradeInput =>
  order.action === "buy" ? { side: "buy", lamports: order.amount } : { side: "sell", baseUnits: order.amount };

/**
 * Whether both pools hold liquidity. Not whether betting is open: anyone can add a little after the
 * oracle closes trading, so the server decides that from the prediction's lockAt (server/markets.ts).
 */
export const isTradingOpen = (pools: MarketPools) => !pools.yes.state.liquidity.isZero() && !pools.no.state.liquidity.isZero();

function openPool(pools: MarketPools, side: Side): DammSnapshot {
  if (!isTradingOpen(pools)) throw new InputError("Betting on this prediction is closed");
  return pools[side];
}

/**
 * A pool holds a limited stock of its token on the 0.001-1 SOL range: a bet that would push the
 * price past 1 SOL (or a sell past 0.001) can't fill. With S SOL seeded per pool, about 0.43 S of
 * buys take a side from 0.5 to 1.
 */
async function withinRange<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PriceRangeViolationError) throw new InputError("Too big for this market right now. Try a smaller amount.");
    throw error;
  }
}

export function quoteMarketTrade(pools: MarketPools, order: MarketOrder, slippageBps: number): Promise<DammQuote> {
  return withinRange(() => quoteDammTrade(openPool(pools, order.side), tradeInput(order), slippageBps));
}

/** Quotes and builds in one step; `atLeast` is the minimum the user saw. */
export async function prepareMarketTrade(
  connection: Connection,
  pools: MarketPools,
  trader: PublicKey,
  order: MarketOrder,
  slippageBps: number,
  atLeast?: BN,
): Promise<BuiltTx & { quote: DammQuote }> {
  return withinRange(() => prepareDammTrade(connection, openPool(pools, order.side), trader, tradeInput(order), slippageBps, atLeast));
}
