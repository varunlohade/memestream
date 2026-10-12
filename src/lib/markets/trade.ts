/**
 * Betting: buying YES or NO with SOL, and selling them back for SOL, in that side's DAMM v2 pool.
 * The same money rules as a graduated coin (lib/damm/trade.ts, reused as is): exact-in swaps, a
 * slippage cap, a minimum that's never zero, and the minimum the user saw as a floor. The pool SDK
 * wraps SOL going in and unwraps SOL coming out, so the wallet only ever sees SOL.
 */
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

/** After closeTrading the pools hold no liquidity: no trade can fill. */
export const isTradingOpen = (pools: MarketPools) => !pools.yes.state.liquidity.isZero() && !pools.no.state.liquidity.isZero();

function openPool(pools: MarketPools, side: Side): DammSnapshot {
  if (!isTradingOpen(pools)) throw new InputError("Betting on this prediction is closed");
  return pools[side];
}

export function quoteMarketTrade(pools: MarketPools, order: MarketOrder, slippageBps: number): DammQuote {
  return quoteDammTrade(openPool(pools, order.side), tradeInput(order), slippageBps);
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
  return prepareDammTrade(connection, openPool(pools, order.side), trader, tradeInput(order), slippageBps, atLeast);
}
