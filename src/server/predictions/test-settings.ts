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

export function testSettings(env: Record<string, string | undefined> = process.env): { prefix: string; waits: Waits } {
  if (env.VERCEL_ENV === "production") return { prefix: DEFAULT_PREFIX, waits: REAL_WAITS };
  return {
    prefix: env.MEMESTREAM_PREDICTIONS_PREFIX || DEFAULT_PREFIX,
    waits: env.MEMESTREAM_PREDICTIONS_FAST === "1" ? { starterAfterMs: FAST_STARTER_AFTER_MS, eligibleAfterMs: FAST_ELIGIBLE_AFTER_MS } : REAL_WAITS,
  };
}
