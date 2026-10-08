/** Short links: memestream's /<ticker> resolves to one coin's page. */
import type { CoinView } from "./api-types";

const TICKER = /^\$?([A-Za-z0-9]{1,10})$/;

/**
 * The coin a ticker link means. Tickers aren't unique, so: a coin still trading beats a graduated
 * one, then the newest launch wins. Null for a malformed ticker or no match.
 */
export function coinForTicker(coins: CoinView[], raw: string): CoinView | null {
  const ticker = decodeURIComponent(raw).match(TICKER)?.[1]?.toUpperCase();
  if (!ticker) return null;
  const matches = coins.filter((c) => c.symbol.toUpperCase() === ticker);
  const rank = (c: CoinView) => (c.status === "trading" ? 1 : 0);
  return matches.sort((a, b) => rank(b) - rank(a) || b.launchedAt - a.launchedAt)[0] ?? null;
}
