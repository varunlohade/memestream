/**
 * Graduation predictions: free points only. No money, no SOL, no tokens, no prizes.
 * Pure rules shared by the server and its tests: constants, settlement and payout math.
 */
import type { CoinStatus } from "@/lib/api-types";

export type Side = "yes" | "no";
/** void: nobody saw the coin graduate before the deadline, but it had graduated by the next look. Everyone gets their points back. */
export type Outcome = Side | "void";

/** Free points each wallet gets, once. There is no way to buy points. */
export const STARTING_POINTS = 1_000;
/** A prediction closes this long after it opens (its first stake). */
export const PREDICTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const isSide = (value: unknown): value is Side => value === "yes" || value === "no";

/**
 * What one look at the coin's status (at time `at`, ms) decides for an open prediction.
 * - Graduated or graduating before the deadline: YES.
 * - Still trading at or after the deadline: NO ("before the deadline" is strict).
 * - Graduated, but first seen at or after the deadline: we can't tell when it happened, so void.
 * - Still trading before the deadline: stays open (null).
 */
export function settlement(status: CoinStatus, at: number, deadline: number): Outcome | null {
  const done = status !== "trading";
  if (at < deadline) return done ? "yes" : null;
  return done ? "void" : "no";
}

export type Stake = { wallet: string; side: Side; amount: number };

/**
 * Parimutuel payout, in whole points. Winners get their stake back plus a pro-rata share of the
 * losing pool. Shares round down; the leftover points go one each to the largest remainders
 * (ties: lower wallet address first), so the total paid always equals the total staked.
 * If either side is empty, or the outcome is void, everyone gets their stake back.
 */
export function payouts(stakes: Stake[], outcome: Outcome): Map<string, number> {
  const result = new Map<string, number>();
  for (const s of stakes) result.set(s.wallet, 0);
  const winners = stakes.filter((s) => s.side === outcome && s.amount > 0);
  const winPool = sum(winners);
  const losePool = sum(stakes) - winPool;
  if (outcome === "void" || winPool === 0n || losePool === 0n) {
    for (const s of stakes) result.set(s.wallet, s.amount);
    return result;
  }
  const shares = winners.map((s) => {
    const numerator = BigInt(s.amount) * losePool;
    return { wallet: s.wallet, stake: s.amount, whole: numerator / winPool, rest: numerator % winPool };
  });
  let leftover = losePool - shares.reduce((total, s) => total + s.whole, 0n);
  const order = [...shares].sort((a, b) => (a.rest === b.rest ? (a.wallet < b.wallet ? -1 : 1) : a.rest > b.rest ? -1 : 1));
  for (const share of order) {
    if (leftover === 0n) break;
    share.whole += 1n;
    leftover -= 1n;
  }
  for (const share of shares) result.set(share.wallet, share.stake + Number(share.whole));
  return result;
}

const sum = (stakes: Stake[]) => stakes.reduce((total, s) => total + BigInt(s.amount), 0n);
