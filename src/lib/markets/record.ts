/**
 * The registry entry for a market the oracle created: every address, as base58, plus when betting
 * closes. The predictions store keeps one per market (written in the same commit that marks the
 * market open), and the app trades, quotes and redeems only in registered markets. Types only.
 */
import type { Side } from "./math";

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
};
