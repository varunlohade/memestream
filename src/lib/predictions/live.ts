/**
 * The home page's "Live predictions" row: predictions open for bets across coins. Pure picking and
 * mapping, shared by the server (GET /api/predictions/live) and the browser (types only).
 */
import type { Side } from "./rules";

/** The row shows at most this many, soonest to close first. */
export const LIVE_SHOWN = 12;

/** A live prediction as the store lists it: `market` only while its on-chain market takes trades. */
export type LiveFound = { mint: string; id: string; text: string; lockAt: number; yes: number; no: number; bettors: number; market: boolean };
/** What the row needs of a coin. */
export type LiveCoin = { mint: string; creator: string; symbol: string; name: string; streamUrl: string | null };

export type LivePrediction = {
  mint: string;
  symbol: string;
  name: string;
  streamUrl: string | null;
  id: string;
  text: string;
  lockAt: number;
  /** "market": real SOL on its YES/NO pool; "points": free points. */
  kind: "market" | "points";
  /** YES/NO chances summing to 1: the market pool's odds, or the points pools' split. Null if the pool couldn't be read just now. */
  probability: Record<Side, number> | null;
  /** Points in the pools (points predictions only). */
  points: number | null;
  bettors: number;
};

export type LiveFeed = { now: number; items: LivePrediction[] };

/**
 * The predictions to show: still open at `now`, on a listed coin whose creator isn't hidden
 * (MEMESTREAM_HIDDEN_CREATORS), soonest to close first, at most `limit`.
 */
export function pickLive(found: LiveFound[], coins: LiveCoin[], hidden: Set<string>, now: number, limit = LIVE_SHOWN) {
  const byMint = new Map(coins.filter((c) => !hidden.has(c.creator)).map((c) => [c.mint, c]));
  return found
    .filter((f) => f.lockAt > now && byMint.has(f.mint))
    .sort((a, b) => a.lockAt - b.lockAt || a.mint.localeCompare(b.mint) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((f) => ({ found: f, coin: byMint.get(f.mint)! }));
}

/** The points pools' split; an empty pool reads as 50/50. */
export function pointsProbability(yes: number, no: number): Record<Side, number> {
  const total = yes + no;
  return total > 0 ? { yes: yes / total, no: no / total } : { yes: 0.5, no: 0.5 };
}

/** One card. `marketOdds`: the market pool's YES/NO chances (markets only; null if not read). */
export function toLivePrediction({ found, coin }: ReturnType<typeof pickLive>[number], marketOdds: Record<Side, number> | null): LivePrediction {
  const market = found.market;
  return {
    mint: coin.mint,
    symbol: coin.symbol,
    name: coin.name,
    streamUrl: coin.streamUrl,
    id: found.id,
    text: found.text,
    lockAt: found.lockAt,
    kind: market ? "market" : "points",
    probability: market ? marketOdds : pointsProbability(found.yes, found.no),
    points: market ? null : found.yes + found.no,
    bettors: found.bettors,
  };
}

const PREDICTION_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** A link from the home row to one question on its coin page, with the side tapped (if any). */
export function predictionHref(mint: string, id: string, side?: Side): string {
  return `/coin/${encodeURIComponent(mint)}?${new URLSearchParams({ p: id, ...(side ? { side } : {}) })}#predictions`;
}

/** The question (and side) a coin page was opened for, from its query string; null if none or malformed. A bad side is just dropped. */
export function predictionPick(search: string): { id: string; side: Side | null } | null {
  const params = new URLSearchParams(search);
  const id = params.get("p") ?? "";
  if (!PREDICTION_ID.test(id)) return null;
  const side = params.get("side");
  return { id, side: side === "yes" || side === "no" ? side : null };
}
