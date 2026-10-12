/**
 * Test-only settings for the end-to-end runs (scripts/predictions-e2e.mts, scripts/markets-e2e.mts).
 * Vercel production ignores them, so production always uses the default Redis prefix and the real
 * challenge window.
 * - MEMESTREAM_PREDICTIONS_PREFIX: the Redis key prefix (default "memestream:pm:").
 * - MEMESTREAM_MARKET_CHALLENGE_MIN (1-120): the market challenge window in minutes (not 2 hours).
 */
import { MARKET_CHALLENGE_MS, MINUTE_MS } from "@/lib/predictions/rules";

export const DEFAULT_PREFIX = "memestream:pm:";

/** A shorter challenge window for test runs; undefined means the real MARKET_CHALLENGE_MS. */
function challengeOverride(env: Record<string, string | undefined>): number | undefined {
  const minutes = Number(env.MEMESTREAM_MARKET_CHALLENGE_MIN);
  return Number.isInteger(minutes) && minutes >= 1 && minutes * MINUTE_MS <= MARKET_CHALLENGE_MS ? minutes * MINUTE_MS : undefined;
}

export function testSettings(env: Record<string, string | undefined> = process.env): { prefix: string; challengeMs?: number } {
  if (env.VERCEL_ENV === "production") return { prefix: DEFAULT_PREFIX };
  const challengeMs = challengeOverride(env);
  return { prefix: env.MEMESTREAM_PREDICTIONS_PREFIX || DEFAULT_PREFIX, ...(challengeMs !== undefined ? { challengeMs } : {}) };
}
