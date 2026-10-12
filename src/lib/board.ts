/** The home board: search, sort and filter tabs, and the "king of the hill" coin. Browser-safe. */
import type { CoinView, TapeItem } from "./api-types";

export const BOARD_TABS = {
  trending: "trending",
  new: "new",
  graduating: "about to graduate",
  graduated: "graduated",
  mcap: "market cap",
} as const;
export type BoardTab = keyof typeof BOARD_TABS;

/** "About to graduate": at least this much of the curve is filled. */
export const ABOUT_TO_GRADUATE = 0.7;

/** Case-blind match on ticker (with or without "$") or name; an empty query matches every coin. */
export function matchesSearch(coin: CoinView, query: string): boolean {
  const q = query.trim().replace(/^\$/, "").toLowerCase();
  return !q || coin.symbol.toLowerCase().includes(q) || coin.name.toLowerCase().includes(q);
}

/** Each coin's newest known trade time (unix seconds), from the ticker tape's trade items. */
export function lastTradeTimes(items: TapeItem[]): Map<string, number> {
  const times = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "trade" || item.time === null) continue;
    times.set(item.mint, Math.max(item.time, times.get(item.mint) ?? 0));
  }
  return times;
}

const byMarketCap = (a: CoinView, b: CoinView) => b.marketCapSol - a.marketCapSol;

/**
 * The coins one tab shows, in order. Trending: coins with a known recent trade first (newest
 * trade first), then the rest by market cap.
 */
export function boardCoins(coins: CoinView[], tab: BoardTab, query: string, lastTrade: Map<string, number>): CoinView[] {
  const found = coins.filter((coin) => matchesSearch(coin, query));
  switch (tab) {
    case "trending":
      return found.sort((a, b) => (lastTrade.get(b.mint) ?? 0) - (lastTrade.get(a.mint) ?? 0) || byMarketCap(a, b));
    case "new":
      return found.sort((a, b) => b.launchedAt - a.launchedAt);
    case "graduating":
      return found.filter((c) => c.status !== "graduated" && c.progress >= ABOUT_TO_GRADUATE).sort((a, b) => b.progress - a.progress);
    case "graduated":
      return found.filter((c) => c.status === "graduated").sort(byMarketCap);
    case "mcap":
      return found.sort(byMarketCap);
  }
}

/** The trading coin closest to graduation (progress below 100%), or null if there is none. */
export function kingOfTheHill(coins: CoinView[]): CoinView | null {
  let king: CoinView | null = null;
  for (const coin of coins) {
    if (coin.status !== "trading" || coin.progress >= 1) continue;
    if (!king || coin.progress > king.progress) king = coin;
  }
  return king;
}
