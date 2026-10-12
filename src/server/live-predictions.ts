/**
 * The home page's "Live predictions" row, across coins: the live-coins index in Redis (two reads),
 * the cached coin list (no extra RPC), and, only when some shown prediction has an open market,
 * one batched read of their YES/NO pools from the RPC budget. Cached 5 s per server instance.
 */
import "server-only";
import { PublicKey } from "@solana/web3.js";
import { fetchDammPools } from "@/lib/damm/pool";
import { hiddenCreators } from "@/lib/hidden-coins";
import { oddsFromPrices, type Side } from "@/lib/markets/math";
import { yesProbability } from "@/lib/markets/pool";
import type { MarketRecord } from "@/lib/markets/record";
import { type LiveFeed, LIVE_SHOWN, pickLive, toLivePrediction } from "@/lib/predictions/live";
import { getChain } from "./chain";
import { listCoins } from "./coins";
import type { PredictionsService } from "./predictions/service";

const CACHE_MS = 5_000;
/** Coins read from the index per refresh: each is MAX_LIVE slot keys in the one Redis read. */
const MAX_COINS = 50;

let cache: { at: number; feed: LiveFeed } | null = null;
let inFlight: Promise<LiveFeed> | null = null;

/** `spend` draws from the RPC budget (one call covers up to 99 pools); if it says no, market odds show as unknown. */
export function liveFeed(service: PredictionsService, spend: (calls: number) => Promise<boolean>): Promise<LiveFeed> {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve({ ...cache.feed, now: Date.now() });
  inFlight ??= load(service, spend)
    .then((feed) => {
      cache = { at: Date.now(), feed };
      return feed;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function load(service: PredictionsService, spend: (calls: number) => Promise<boolean>): Promise<LiveFeed> {
  const coins = await listCoins();
  const hidden = hiddenCreators(process.env.MEMESTREAM_HIDDEN_CREATORS);
  const shown = new Set(coins.filter((c) => !hidden.has(c.creator)).map((c) => c.mint));
  const found = await service.liveAcross((mint) => shown.has(mint), MAX_COINS);
  const now = Date.now();
  const picked = pickLive(
    found.map((f) => ({ ...f, market: f.market !== null })),
    coins,
    hidden,
    now,
    LIVE_SHOWN,
  );
  const records = new Map(found.filter((f) => f.market).map((f) => [`${f.mint}:${f.id}`, f.market!]));
  const markets = picked.map(({ found: f }) => records.get(`${f.mint}:${f.id}`)).filter((r) => r !== undefined);
  const odds = await marketOdds(markets, spend);
  return { now, items: picked.map((p) => toLivePrediction(p, odds.get(`${p.found.mint}:${p.found.id}`) ?? null)) };
}

/** Each open market's YES/NO chances from its pool's price, in one batched read; empty if the budget says no or the read fails. */
async function marketOdds(records: MarketRecord[], spend: (calls: number) => Promise<boolean>) {
  const odds = new Map<string, Record<Side, number>>();
  if (records.length === 0 || !(await spend(1))) return odds;
  try {
    const states = await fetchDammPools(getChain().connection, records.map((r) => new PublicKey(r.pool)));
    records.forEach((r, i) => {
      const state = states[i];
      // Token A is YES in our pools; anything else isn't the pool the oracle made.
      if (!state || state.tokenAMint.toBase58() !== r.mints.yes) return;
      const yes = yesProbability(state.sqrtPrice);
      odds.set(`${r.mint}:${r.predictionId}`, oddsFromPrices(yes, 1 - yes).probability);
    });
  } catch (error) {
    console.warn(`live predictions: market pool read failed (${(error as Error).message}); odds shown as unknown`);
  }
  return odds;
}
