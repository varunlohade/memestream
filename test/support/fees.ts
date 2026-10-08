/** Fee math for the chain tests. */
import type BN from "bn.js";
import type { TradeQuote } from "../../src/lib/dbc/trade";

/** Basis points as a share of 1 (100 bps -> 0.01). */
export const shareOfBps = (bps: number) => bps / 10_000;

/** Total fee (trading + protocol) as a share of the SOL paid in. Buy fees are taken in SOL. */
export const buyFeeShare = (quote: TradeQuote, lamportsIn: BN) => quote.tradingFee.add(quote.protocolFee).toNumber() / lamportsIn.toNumber();
