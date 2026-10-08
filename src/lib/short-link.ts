/** Short links: memestream's /<ticker> resolves to one coin's page. */
import type { CoinView } from "./api-types";

const TICKER = /^\$?([A-Za-z0-9]{1,10})$/;

/** What every launch stores: 1-10 ASCII capitals and digits. Nothing else can look like another ticker. */
const CANONICAL = /^[A-Z0-9]{1,10}$/;

/**
 * True for a ticker in exactly the form our launch writes. Coins launched straight on-chain skip
 * our check, so look-alikes (Cyrillic "ХQС", lower case, symbols) fail this and are hidden.
 */
export const isCanonicalTicker = (symbol: string) => CANONICAL.test(symbol);

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
  // Exact match only: no case folding of on-chain symbols (Unicode upper-casing can create look-alikes).
  const matches = coins.filter((c) => c.symbol === ticker && isCanonicalTicker(c.symbol));
  return matches.sort((a, b) => a.launchedAt - b.launchedAt || a.mint.localeCompare(b.mint))[0] ?? null;
}
