/** Short links: memestream's /<ticker> resolves to one coin's page. */
import type { CoinView } from "./api-types";

const TICKER = /^\$?([A-Za-z0-9]{1,10})$/;

/** The ticker in canonical form (upper case, no $), or null if it isn't 1-10 letters or digits. */
export function parseTicker(raw: string): string | null {
  return raw.match(TICKER)?.[1]?.toUpperCase() ?? null;
}

/**
 * The coin a ticker link means. Tickers aren't unique on-chain (anyone can launch on our config),
 * so the FIRST coin launched with a ticker owns its link forever: a later copycat can't take over
 * a streamer's overlay link. Null for a malformed ticker or no match.
 */
export function coinForTicker(coins: CoinView[], raw: string): CoinView | null {
  const ticker = parseTicker(raw);
  if (!ticker) return null;
  const matches = coins.filter((c) => c.symbol.toUpperCase() === ticker);
  return matches.sort((a, b) => a.launchedAt - b.launchedAt || a.mint.localeCompare(b.mint))[0] ?? null;
}
