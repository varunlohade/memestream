/**
 * Server wiring for predictions (free points, no money): the feature flag, the store (Upstash
 * Redis, or an in-memory DEV-ONLY store), the session secret, and the coin's streamer from the
 * cached, RPC-budgeted getCoinDetail (no new RPC load).
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import { getCoinDetail } from "@/server/coins";
import { predictionsService, type PredictionsService } from "./service";
import { memoryStore, redisStore } from "./store";

export { predictionsEnabled } from "./flag";

let cached: { service: PredictionsService } | { error: string } | undefined;
/** DEV ONLY: without a configured secret, a random one per process (sessions end on restart). */
let devSecret: string | undefined;

/** The service, or why it can't run (production needs Redis and a secret). */
export function predictions(): { service: PredictionsService } | { error: string } {
  if (cached) return cached;
  const production = process.env.NODE_ENV === "production";
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  let secret = process.env.MEMESTREAM_PREDICTIONS_SECRET ?? "";
  if (secret.length < 32) {
    if (production) return (cached = { error: "Predictions are not set up (no session secret)" });
    devSecret ??= randomBytes(32).toString("hex");
    secret = devSecret;
  }
  let store;
  if (url && token) {
    store = redisStore(new Redis({ url, token, automaticDeserialization: false }));
  } else if (production) {
    return (cached = { error: "Predictions are not set up (no Redis)" });
  } else {
    console.warn("predictions: no Redis configured, using the in-memory DEV-ONLY store (lost on restart)");
    store = memoryStore();
  }
  const service = predictionsService({
    store,
    now: Date.now,
    secret,
    creatorOf: async (mint) => (await getCoinDetail(mint, null))?.coin.creator ?? null,
  });
  return (cached = { service });
}
