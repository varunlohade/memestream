import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinView } from "./api-types";
import { coinForTicker } from "./short-link";

const coin = (mint: string, symbol: string, status: CoinView["status"], launchedAt: number) =>
  ({ mint, symbol, status, launchedAt }) as CoinView;

test("a ticker link finds its coin, ignoring case and a leading $", () => {
  const coins = [coin("a", "LOFI", "trading", 1), coin("b", "SYNTH", "trading", 2)];
  assert.equal(coinForTicker(coins, "lofi")?.mint, "a");
  assert.equal(coinForTicker(coins, "%24LOFI")?.mint, "a");
  assert.equal(coinForTicker(coins, "NOPE"), null);
  assert.equal(coinForTicker(coins, "../etc"), null);
  assert.equal(coinForTicker(coins, "TOOLONGTICKER1"), null);
});

test("on a clash, a trading coin beats a graduated one, then the newest wins", () => {
  const coins = [coin("old", "MIRA", "trading", 1), coin("grad", "MIRA", "graduated", 9), coin("new", "MIRA", "trading", 5)];
  assert.equal(coinForTicker(coins, "MIRA")?.mint, "new");
  assert.equal(coinForTicker([coin("grad", "MIRA", "graduated", 9)], "MIRA")?.mint, "grad");
});
