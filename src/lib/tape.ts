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

/** Below this many items the tape also shows the graduation race. */
const TAPE_MIN_ITEMS = 4;

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

  // Back-to-back trades by the same wallet, side and coin read as one ("bought 0.015 SOL"), so the
  // tape never shows the same line three times in a row.
  const merged: { mint: string; t: TradeView; sol: number }[] = [];
  for (const entry of trades) {
    const last = merged.at(-1);
    if (last && last.mint === entry.mint && last.t.wallet === entry.t.wallet && last.t.side === entry.t.side) last.sol += Number(entry.t.sol);
    else merged.push({ ...entry, sol: Number(entry.t.sol) });
  }

  const items: TapeItem[] = coins
    .filter((c) => c.status === "graduated")
    .map((c) => ({ kind: "graduated", mint: c.mint, symbol: c.symbol }));
  items.push(
    ...merged.map(({ mint, t, sol }): TapeItem => ({
      kind: "trade", mint, symbol: symbolOf.get(mint) ?? "", side: t.side, sol: String(Number(sol.toFixed(9))), wallet: t.wallet, time: t.time,
    })),
  );

  const recent = trades.filter(({ t }) => t.time !== null && nowSeconds - t.time <= TAPE_RECENT_SECONDS).length;
  // Quiet tape (few recent trades, or few items at all): add the coins racing to graduate, so it never
  // loops one line. A full curve waiting to graduate counts too.
  if (recent < TAPE_MIN_RECENT || items.length < TAPE_MIN_ITEMS) {
    const race = coins
      .filter((c) => c.status !== "graduated")
      .sort((a, b) => b.progress - a.progress)
      .slice(0, TAPE_MAX_RACE)
      .map((c): TapeItem => ({ kind: "race", mint: c.mint, symbol: c.symbol, progress: c.progress }));
    items.push(...race);
  }
  return items;
}
