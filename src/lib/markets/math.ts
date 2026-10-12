/**
 * Pure maths for prediction markets: no network, no SDKs. A market is a yes/no question on a coin's
 * prediction. Its YES and NO tokens each redeem for up to 1 SOL, so a token's SOL price is the
 * market's probability for that side.
 */
import { createHmac } from "node:crypto";
import type { PublicKey } from "@solana/web3.js";

export type Side = "yes" | "no";
/** How a market settles: one side wins, or "refund" (disputed or cancelled) pays every token half. */
export type Outcome = Side | "refund";

/** Conditional token index per side, in the order of the question's payout numerators. */
export const OUTCOME_INDEX: Record<Side, number> = { yes: 0, no: 1 };
export const NUM_OUTCOMES = 2;

/** Prediction ids are the predictions engine's numeric ids (up to 9 digits). */
const PREDICTION_ID = /^[1-9]\d{0,8}$/;

export const isPredictionId = (id: string) => PREDICTION_ID.test(id);

/** The server secret that keys question ids must be at least this long. */
export const MIN_MARKET_SECRET_CHARS = 32;

/**
 * The 32-byte MetaDAO question id for a coin's prediction: an HMAC under the server's secret, so
 * nobody can work out a market's addresses (question, vault, YES/NO mints, pools) before the
 * oracle creates it, and squat them. Deterministic for the server, so a retried create is the same market.
 */
export function questionIdFor(secret: string, coinMint: PublicKey, predictionId: string): Uint8Array {
  if (secret.length < MIN_MARKET_SECRET_CHARS) throw new Error("Market secret is too short");
  if (!isPredictionId(predictionId)) throw new Error(`Not a prediction id: "${predictionId}"`);
  return new Uint8Array(createHmac("sha256", secret).update(`memestream:market:v2:${coinMint.toBase58()}:${predictionId}`).digest());
}

/** resolveQuestion's payout numerators: [YES, NO]. A refund pays each token half its full value. */
export function payoutNumerators(outcome: Outcome): number[] {
  switch (outcome) {
    case "yes":
      return [1, 0];
    case "no":
      return [0, 1];
    case "refund":
      return [1, 1];
  }
}

/** Lamports one token pays at redemption under these numerators (both sides use 9 decimals). */
export function redeemLamports(tokenAmount: bigint, side: Side, numerators: readonly number[]): bigint {
  const total = numerators.reduce((sum, n) => sum + n, 0);
  if (total === 0) throw new Error("Payout numerators must not all be zero");
  return (tokenAmount * BigInt(numerators[OUTCOME_INDEX[side]])) / BigInt(total);
}

const Q64 = BigInt(1) << BigInt(64);

/**
 * SOL per outcome token from a DAMM v2 pool's sqrt price (Q64.64; token A = outcome, token B =
 * wSOL, both 9 decimals, so no decimal shift).
 */
export function priceFromSqrtPrice(sqrtPriceQ64: bigint): number {
  const scaled = (sqrtPriceQ64 * sqrtPriceQ64 * BigInt(1_000_000_000_000)) / (Q64 * Q64);
  return Number(scaled) / 1e12;
}

export type MarketOdds = {
  /** SOL to buy one token at the margin, per side (before fees). */
  priceSol: Record<Side, number>;
  /** The two prices scaled to sum to 1: what the UI shows as "62% YES". */
  probability: Record<Side, number>;
};

/** Each pool is priced on its own, so YES + NO can drift from 1 SOL; probability normalises that. */
export function oddsFromPrices(yes: number, no: number): MarketOdds {
  const sum = yes + no;
  if (!(sum > 0)) throw new Error("Both prices are zero");
  return { priceSol: { yes, no }, probability: { yes: yes / sum, no: no / sum } };
}
