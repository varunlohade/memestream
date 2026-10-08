/**
 * The ticker tape (SPEC "Ticker tape", design B): the latest trades the app already has, newest
 * first, plus graduations. When fewer than MIN_RECENT trades happened in the last half hour, the
 * rest is filled with "graduation race" items from the coin list, so the tape is never empty or
 * stuck on old trades. No coins at all: an empty tape (the strip hides).
 */
import type { CoinView, TapeItem, TradeView } from "./api-types";

export const TAPE_MAX_TRADES = 20;
export const TAPE_MIN_RECENT = 5;
export const TAPE_RECENT_SECONDS = 30 * 60;
const TAPE_MAX_RACE = 8;

export function buildTape(coins: CoinView[], tradesByMint: Map<string, TradeView[]>, nowSeconds: number): TapeItem[] {
  if (coins.length === 0) return [];
  const symbolOf = new Map(coins.map((c) => [c.mint, c.symbol]));

  const seen = new Set<string>();
  const trades = [...tradesByMint.entries()]
    .filter(([mint]) => symbolOf.has(mint)) // only coins the list shows (look-alikes stay hidden)
    .flatMap(([mint, list]) => list.map((t) => ({ mint, t })))
    .filter(({ t }) => !seen.has(t.signature) && seen.add(t.signature))
    .sort((a, b) => (b.t.time ?? 0) - (a.t.time ?? 0))
    .slice(0, TAPE_MAX_TRADES);

  const items: TapeItem[] = coins
    .filter((c) => c.status === "graduated")
    .map((c) => ({ kind: "graduated", mint: c.mint, symbol: c.symbol }));
  items.push(
    ...trades.map(({ mint, t }): TapeItem => ({
      kind: "trade", mint, symbol: symbolOf.get(mint) ?? "", side: t.side, sol: t.sol, wallet: t.wallet, time: t.time,
    })),
  );

  const recent = trades.filter(({ t }) => t.time !== null && nowSeconds - t.time <= TAPE_RECENT_SECONDS).length;
  if (recent < TAPE_MIN_RECENT) {
    const race = coins
      .filter((c) => c.status === "trading")
      .sort((a, b) => b.progress - a.progress)
      .slice(0, TAPE_MAX_RACE)
      .map((c): TapeItem => ({ kind: "race", mint: c.mint, symbol: c.symbol, progress: c.progress }));
    items.push(...race);
  }
  return items;
}
