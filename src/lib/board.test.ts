import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinView, TapeItem } from "./api-types";
import { boardCoins, kingOfTheHill, lastTradeTimes, matchesSearch } from "./board";

const coin = (symbol: string, over: Partial<CoinView> = {}) =>
  ({ mint: `m-${symbol}`, symbol, name: `${symbol} stream`, status: "trading", progress: 0.1, marketCapSol: 1, launchedAt: 0, ...over }) as CoinView;
const symbols = (coins: CoinView[]) => coins.map((c) => c.symbol);

const COINS = [
  coin("AAA", { marketCapSol: 5, launchedAt: 10, progress: 0.75 }),
  coin("BBB", { marketCapSol: 9, launchedAt: 30, progress: 0.2 }),
  coin("CCC", { marketCapSol: 2, launchedAt: 20, progress: 0.95 }),
  coin("GRAD", { marketCapSol: 50, launchedAt: 5, progress: 1, status: "graduated" }),
  coin("FULL", { marketCapSol: 7, launchedAt: 1, progress: 1, status: "graduating" }),
];

test("search matches ticker (with or without $) or name, case-blind", () => {
  assert.ok(matchesSearch(coin("LOFI", { name: "late-night lofi" }), "lofi"));
  assert.ok(matchesSearch(coin("LOFI"), "$lo"));
  assert.ok(matchesSearch(coin("GAMER", { name: "Ranked grind" }), "GRIND"));
  assert.ok(matchesSearch(coin("X"), "  "));
  assert.ok(!matchesSearch(coin("LOFI", { name: "late-night" }), "news"));
});

test("tabs: new, market cap, about to graduate, graduated", () => {
  const none = new Map<string, number>();
  assert.deepEqual(symbols(boardCoins(COINS, "new", "", none)), ["BBB", "CCC", "AAA", "GRAD", "FULL"]);
  assert.deepEqual(symbols(boardCoins(COINS, "mcap", "", none)), ["GRAD", "BBB", "FULL", "AAA", "CCC"]);
  assert.deepEqual(symbols(boardCoins(COINS, "graduating", "", none)), ["FULL", "CCC", "AAA"]);
  assert.deepEqual(symbols(boardCoins(COINS, "graduated", "", none)), ["GRAD"]);
});

test("trending: newest trade first, then market cap; search narrows every tab", () => {
  const lastTrade = new Map([["m-CCC", 500], ["m-AAA", 900]]);
  assert.deepEqual(symbols(boardCoins(COINS, "trending", "", lastTrade)), ["AAA", "CCC", "GRAD", "BBB", "FULL"]);
  assert.deepEqual(symbols(boardCoins(COINS, "trending", "", new Map())), ["GRAD", "BBB", "FULL", "AAA", "CCC"]);
  assert.deepEqual(symbols(boardCoins(COINS, "mcap", "c", new Map())), ["CCC"]);
});

test("the input list is never reordered", () => {
  const before = symbols(COINS);
  boardCoins(COINS, "new", "", new Map());
  assert.deepEqual(symbols(COINS), before);
});

test("last trade times: newest trade per coin from the tape", () => {
  const items: TapeItem[] = [
    { kind: "trade", mint: "a", symbol: "A", side: "buy", sol: "1", wallet: "w", time: 100 },
    { kind: "trade", mint: "a", symbol: "A", side: "sell", sol: "1", wallet: "w", time: 300 },
    { kind: "trade", mint: "b", symbol: "B", side: "buy", sol: "1", wallet: "w", time: null },
    { kind: "race", mint: "c", symbol: "C", progress: 0.5 },
  ];
  assert.deepEqual([...lastTradeTimes(items)], [["a", 300]]);
});

test("king of the hill: the trading coin with the most progress below 100%", () => {
  assert.equal(kingOfTheHill(COINS)?.symbol, "CCC");
  assert.equal(kingOfTheHill([coin("X", { progress: 1 }), coin("G", { status: "graduated", progress: 0.5 })]), null);
  assert.equal(kingOfTheHill([]), null);
});
