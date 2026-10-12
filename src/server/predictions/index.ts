/**
 * Server wiring for predictions (free points, no money): the feature flag, the store (Upstash
 * Redis, or an in-memory DEV-ONLY store), the session secret and domain, and coin facts from the
 * cached, RPC-budgeted getCoinDetail (no unbudgeted RPC).
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { Redis } from "@upstash/redis";
import { holdsEnough } from "@/lib/predictions/rules";
import { isBase58Of } from "@/lib/base58";
import { isPredictionId } from "@/lib/markets/math";
import type { MarketRecord } from "@/lib/markets/record";
import { getCoinDetail } from "@/server/coins";
import { closeMarketTrading, createMarket, MarketUnavailableError, redeemOracleTokens, resolveMarket, walletHoldsShares } from "@/server/markets";
import { UserError } from "@/server/errors";
import { aiCheckFromEnv } from "./ai-check";
import { reviewFromEnv } from "./review";
import { marketsEnabled } from "./flag";
import { type MarketDeps, MarketUnavailable, predictionsService, type PredictionsService } from "./service";
import { memoryStore, redisStore } from "./store";
import { testSettings } from "./test-settings";

export { marketsEnabled, predictionsEnabled } from "./flag";

/** SOL the oracle seeds a market with (split into YES + NO, all in the pool; it comes back at redemption). */
const DEFAULT_SEED_SOL = "0.05";

/** One oracle step at a time in this process: they share the oracle's wrapped-SOL account. */
let oracleQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = oracleQueue.then(work, work);
  oracleQueue = next.catch(() => undefined);
  return next;
}

/** MEMESTREAM_ADMIN_WALLETS: a comma list of the wallets that settle market challenges (never the streamer). */
const adminWallets = () =>
  (process.env.MEMESTREAM_ADMIN_WALLETS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => isBase58Of(w, 32));

/** The oracle's market steps, or null with MEMESTREAM_MARKETS off. */
function marketDeps(): MarketDeps | null {
  if (!marketsEnabled()) return null;
  const seedSol = process.env.MEMESTREAM_MARKET_SEED_SOL || DEFAULT_SEED_SOL;
  return {
    create: (mint, predictionId, ticker) =>
      oneAtATime(async () => {
        try {
          return (await createMarket({ mint, predictionId, ticker, seedSol })).record;
        } catch (error) {
          throw error instanceof MarketUnavailableError ? new MarketUnavailable(error.message) : error;
        }
      }),
    close: (record) => oneAtATime(() => closeMarketTrading(record)),
    resolve: (record, outcome) => oneAtATime(() => resolveMarket(record, outcome)),
    holdsShares: walletHoldsShares,
    redeemOracle: (record) => oneAtATime(() => redeemOracleTokens(record)),
  };
}

/**
 * The registered market of a coin's prediction (only markets the oracle created); throws a user
 * error if there's none. With `bettor`, also refuses the coin's streamer and mods (they resolve it).
 * Callers pass the same `wallet` the trade is built for: that wallet is its fee payer and only
 * signer, so no other wallet can sign a trade that passed this check.
 */
export async function registeredMarket(mint: string, predictionId: string, bettor?: string): Promise<MarketRecord> {
  if (!isBase58Of(mint, 32) || !isPredictionId(predictionId)) throw new UserError("No market for this prediction");
  const ready = marketsEnabled() ? predictions() : null;
  if (!ready || !("service" in ready)) throw new UserError("No market for this prediction");
  const record = await ready.service.market(mint, predictionId);
  if (!record) throw new UserError("No market for this prediction");
  if (bettor !== undefined && (await ready.service.staffOf(mint, bettor))) throw new UserError("Streamers and mods can't bet on their own coin's predictions");
  return record;
}

/** "Holds this coin" answers are reused this long per wallet and coin. */
const HOLDS_CACHE_MS = 60_000;
/** Past this many cached answers, the expired ones are swept out. */
const HOLDS_CACHE_SWEEP_AT = 5_000;
const holdsCache = new Map<string, { at: number; holds: boolean }>();

/** Whether `wallet` holds at least 1 whole coin: the budgeted holdings read, cached for a minute. */
async function holds(mint: string, wallet: string): Promise<boolean> {
  const key = `${mint}|${wallet}`;
  const hit = holdsCache.get(key);
  if (hit && Date.now() - hit.at < HOLDS_CACHE_MS) return hit.holds;
  const detail = await getCoinDetail(mint, wallet); // throws BusyError when the RPC budget says no
  const answer = holdsEnough(detail?.holdings?.coins);
  holdsCache.set(key, { at: Date.now(), holds: answer });
  if (holdsCache.size > HOLDS_CACHE_SWEEP_AT) for (const [k, v] of holdsCache) if (Date.now() - v.at >= HOLDS_CACHE_MS) holdsCache.delete(k);
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
  const { prefix, waits, challengeMs } = testSettings();
  let store;
  if (url && token) {
    // The SDK's default retries stay on: it re-sends a request whose fetch threw. Reads and ticks
    // are safe to repeat, an action's commit carries a one-time id (a re-send answers "replay"),
    // and a re-sent heartbeat is refused as too soon. Turning retries off would only turn brief
    // network blips into errors for actions that did save.
    store = redisStore(new Redis({ url, token, automaticDeserialization: false }), prefix);
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
    review: reviewFromEnv(),
    ai: aiCheckFromEnv(),
    markets: marketDeps(),
    admins: adminWallets(),
    challengeMs,
    defer: (task) => after(task),
    coin: async (mint) => {
      const coin = (await getCoinDetail(mint, null))?.coin;
      return coin ? { creator: coin.creator, status: coin.status, streamUrl: coin.streamUrl, symbol: coin.symbol } : null;
    },
    holds,
    waits,
  });
  return (cached = { service });
}
