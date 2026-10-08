/**
 * Rate limits shared by every server instance (Vercel runs many), stored in Upstash Redis.
 * Without Redis env vars (local dev, tests) or when Redis is slow or down, each instance falls
 * back to its own in-memory buckets, so the site stays up and still has a per-instance cap.
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { KeyedLimiter } from "./rate-limit";

/** Redis answers in a few ms; past this, use the local bucket instead of waiting. */
const REDIS_TIMEOUT_MS = 800;
/** After a Redis failure, skip it for a while, so an outage doesn't slow every request. */
const REDIS_PAUSE_MS = 30_000;
let redisDownUntil = 0;

let redis: Redis | null | undefined;
function sharedRedis(): Redis | null {
  if (redis === undefined) {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    redis = url && token ? new Redis({ url, token }) : null;
  }
  return redis;
}

export type Limiter = {
  /** Takes `cost` tokens for `key`; false means over the limit. */
  take: (key: string, cost?: number) => Promise<boolean>;
  /** "shared" when Redis decided, "local" when the in-memory fallback did (for tests and logs). */
  lastSource: () => "shared" | "local";
};

/** A token bucket per key: `burst` at most, refilled by `perSecond` (a whole number). */
export function sharedLimiter(name: string, burst: number, perSecond: number): Limiter {
  const local = new KeyedLimiter(burst, perSecond);
  let source: "shared" | "local" = "local";
  let shared: Ratelimit | null | undefined;
  const remote = () => {
    if (shared === undefined) {
      const client = sharedRedis();
      shared = client
        ? new Ratelimit({
            redis: client,
            prefix: `memestream:${name}`,
            limiter: Ratelimit.tokenBucket(perSecond, "1 s", burst),
            timeout: REDIS_TIMEOUT_MS,
            // No local "blocked" cache: a refused key must be able to retry as soon as it refills.
            ephemeralCache: false,
          })
        : null;
    }
    return shared;
  };
  return {
    async take(key, cost = 1) {
      const limiter = Date.now() >= redisDownUntil ? remote() : null;
      if (limiter) {
        try {
          const result = await limiter.limit(key, { rate: cost });
          // On timeout the library answers "allowed"; we don't trust that and decide locally.
          if (result.reason !== "timeout") {
            source = "shared";
            return result.success;
          }
          redisDownUntil = Date.now() + REDIS_PAUSE_MS;
        } catch (error) {
          redisDownUntil = Date.now() + REDIS_PAUSE_MS;
          console.warn(`shared rate limit ${name} unavailable for ${REDIS_PAUSE_MS / 1000} s, using local:`, (error as Error).message);
        }
      }
      source = "local";
      return local.take(key, Date.now(), cost);
    },
    lastSource: () => source,
  };
}
