/**
 * Test-only settings for the predictions end-to-end run (scripts/predictions-e2e.mts). Vercel
 * production ignores them, so production always uses the default Redis prefix and the real waits.
 * - MEMESTREAM_PREDICTIONS_PREFIX: the Redis key prefix (default "memestream:pm:").
 * - MEMESTREAM_PREDICTIONS_FAST=1: starter points after 1 minute watched (not 10), upvotes and bets
 *   count as eligible after 2 minutes (not 15). Heartbeat spacing, bet sizes and windows stay.
 */
import { ELIGIBLE_AFTER_MS, MINUTE_MS, STARTER_AFTER_MS } from "@/lib/predictions/rules";

export const DEFAULT_PREFIX = "memestream:pm:";
const FAST_STARTER_AFTER_MS = MINUTE_MS;
const FAST_ELIGIBLE_AFTER_MS = 2 * MINUTE_MS;

export type Waits = { starterAfterMs: number; eligibleAfterMs: number };
export const REAL_WAITS: Waits = { starterAfterMs: STARTER_AFTER_MS, eligibleAfterMs: ELIGIBLE_AFTER_MS };

/**
 * MEMESTREAM_PREDICTIONS_STARTER_MIN (1-10, production too): minutes watched before the starter
 * points, so Boss man can test rounds back to back. Unset or invalid: the real 10 minutes.
 */
function starterOverride(env: Record<string, string | undefined>): number | null {
  const minutes = Number(env.MEMESTREAM_PREDICTIONS_STARTER_MIN);
  return Number.isInteger(minutes) && minutes >= 1 && minutes * MINUTE_MS <= STARTER_AFTER_MS ? minutes * MINUTE_MS : null;
}

export function testSettings(env: Record<string, string | undefined> = process.env): { prefix: string; waits: Waits } {
  const starter = starterOverride(env);
  const real = starter === null ? REAL_WAITS : { ...REAL_WAITS, starterAfterMs: starter };
  if (env.VERCEL_ENV === "production") return { prefix: DEFAULT_PREFIX, waits: real };
  return {
    prefix: env.MEMESTREAM_PREDICTIONS_PREFIX || DEFAULT_PREFIX,
    waits: env.MEMESTREAM_PREDICTIONS_FAST === "1" ? { starterAfterMs: FAST_STARTER_AFTER_MS, eligibleAfterMs: FAST_ELIGIBLE_AFTER_MS } : real,
  };
}
