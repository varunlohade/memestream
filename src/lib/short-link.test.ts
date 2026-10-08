import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinView } from "./api-types";
import { coinForTicker, isCanonicalTicker, parseTicker } from "./short-link";

const coin = (mint: string, symbol: string, status: CoinView["status"], launchedAt: number) =>
  ({ mint, symbol, status, launchedAt }) as CoinView;

test("a ticker link finds its coin, ignoring case and a leading $", () => {
  const coins = [coin("a", "LOFI", "trading", 1), coin("b", "SYNTH", "trading", 2)];
  assert.equal(coinForTicker(coins, "lofi")?.mint, "a");
  assert.equal(coinForTicker(coins, "$LOFI")?.mint, "a");
  assert.equal(coinForTicker(coins, "NOPE"), null);
});

test("malformed tickers never match and never throw", () => {
  for (const bad of ["../etc", "TOOLONGTICKER1", "%E0%A4%A", "robots.txt", "MOON-1", ""]) {
    assert.equal(parseTicker(bad), null, bad);
    assert.equal(coinForTicker([coin("a", "LOFI", "trading", 1)], bad), null, bad);
  }
});

test("the first coin with a ticker owns its link: a later copycat can't take it", () => {
  const original = coin("orig", "LOFI", "graduated", 1);
  const copycat = coin("copy", "LOFI", "trading", 9);
  assert.equal(coinForTicker([copycat, original], "LOFI")?.mint, "orig");
});

test("only tickers our launch could write count: look-alikes never claim a link", () => {
  assert.ok(isCanonicalTicker("XQC") && isCanonicalTicker("A1"));
  for (const bad of ["ХQС", "xqc", "XQC!", "", "ELEVENCHARS", "Ⅹqc"]) assert.equal(isCanonicalTicker(bad), false, bad);
  // A direct on-chain launch with a Cyrillic look-alike, launched first, still can't take /XQC.
  const lookAlike = coin("fake", "ХQС", "trading", 1);
  const real = coin("real", "XQC", "trading", 2);
  assert.equal(coinForTicker([lookAlike, real], "XQC")?.mint, "real");
  assert.equal(coinForTicker([coin("lower", "xqc", "trading", 1)], "XQC"), null, "no case folding of on-chain symbols");
});
