/**
 * Server wiring for predictions (free points, no money): the feature flag, the store (Upstash
 * Redis, or an in-memory DEV-ONLY store), the session secret and domain, and coin facts from the
 * cached, RPC-budgeted getCoinDetail (no unbudgeted RPC).
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import { holdsEnough } from "@/lib/predictions/rules";
import { getCoinDetail } from "@/server/coins";
import { predictionsService, type PredictionsService } from "./service";
import { memoryStore, redisStore } from "./store";

export { predictionsEnabled } from "./flag";

/** "Holds this coin" answers are reused this long per wallet and coin. */
const HOLDS_CACHE_MS = 60_000;
const holdsCache = new Map<string, { at: number; holds: boolean }>();

/** Whether `wallet` holds at least 1 whole coin: the budgeted holdings read, cached for a minute. */
async function holds(mint: string, wallet: string): Promise<boolean> {
  const key = `${mint}|${wallet}`;
  const hit = holdsCache.get(key);
  if (hit && Date.now() - hit.at < HOLDS_CACHE_MS) return hit.holds;
  const detail = await getCoinDetail(mint, wallet); // throws BusyError when the RPC budget says no
  const answer = holdsEnough(detail?.holdings?.coins);
  holdsCache.set(key, { at: Date.now(), holds: answer });
  if (holdsCache.size > 5_000) for (const [k, v] of holdsCache) if (Date.now() - v.at >= HOLDS_CACHE_MS) holdsCache.delete(k);
  return answer;
}

let cached: { service: PredictionsService } | { error: string } | undefined;
/** DEV ONLY: without a configured secret, a random one per process (sessions end on restart). */
let devSecret: string | undefined;

/** The service, or why it can't run (production needs Redis, a secret and the public URL). */
export function predictions(): { service: PredictionsService } | { error: string } {
  if (cached) return cached;
  const production = process.env.NODE_ENV === "production";
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  let domain: string;
  try {
    domain = new URL(process.env.MEMESTREAM_PUBLIC_URL ?? "").host;
  } catch {
    return (cached = { error: "Predictions are not set up (no MEMESTREAM_PUBLIC_URL)" });
  }
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
    domain,
    coin: async (mint) => {
      const coin = (await getCoinDetail(mint, null))?.coin;
      return coin ? { creator: coin.creator, status: coin.status } : null;
    },
    holds,
  });
  return (cached = { service });
}
