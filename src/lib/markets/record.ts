/**
 * The registry entry for a market the oracle created: every address, as base58, plus when betting
 * closes. The predictions store keeps one per market (written in the same commit that marks the
 * market open), and the app trades, quotes and redeems only in registered markets. Also what the
 * odds API returns. Types only, so the browser can import them.
 */
import type { MarketOdds, Side } from "./math";

export type MarketRecord = {
  mint: string;
  predictionId: string;
  oracle: string;
  /** The 32-byte question id, hex. */
  questionId: string;
  question: string;
  vault: string;
  mints: Record<Side, string>;
  pools: Record<Side, string>;
  /** The last create transaction the oracle sent ("" if every step was already on chain). */
  signature: string;
  /** Betting closes then (ms): trades are refused from that moment, whatever the pools hold. */
  lockAt: number;
  /** What it resolves from: the streamer's official link, or the coin's stream ("" if none). */
  source: string;
};

/** A wallet's YES and NO shares and its SOL, as decimal strings. */
export type MarketPosition = { yes: string; no: string; sol: string };

/** /api/markets/odds: a registered market's odds and state, and the wallet's position if one was given. */
export type MarketView = MarketOdds & {
  trading: boolean;
  resolved: boolean;
  /** [YES, NO] once resolved: [1,0] YES won, [0,1] NO won, [1,1] refund. */
  payoutNumerators: number[] | null;
  lockAt: number;
  volumeSol: string;
  /** The most SOL a buy of each side can spend right now (the pool's stock limit). */
  maxBuySol: Record<Side, string>;
  position: MarketPosition | null;
};
