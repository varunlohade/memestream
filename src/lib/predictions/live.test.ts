import assert from "node:assert/strict";
import { test } from "node:test";
import { hiddenCreators } from "../hidden-coins";
import { type LiveCoin, type LiveFound, pickLive, pointsProbability, predictionHref, predictionPick, toLivePrediction } from "./live";

const NOW = 1_000_000;
const coin = (mint: string, creator = "streamer"): LiveCoin => ({ mint, creator, symbol: mint.toUpperCase(), name: `${mint} coin`, streamUrl: null });
const found = (mint: string, id: string, lockAt: number, over: Partial<LiveFound> = {}): LiveFound => ({ mint, id, text: `${mint} ${id}?`, lockAt, yes: 0, no: 0, bettors: 0, market: false, ...over });

test("pickLive: open predictions on listed coins, soonest to close first, at most the limit", () => {
  const coins = [coin("a"), coin("b")];
  const all = [found("a", "1", NOW + 90_000), found("b", "2", NOW + 30_000), found("a", "3", NOW), found("gone", "4", NOW + 10_000), found("b", "5", NOW + 60_000)];
  const picked = pickLive(all, coins, new Set(), NOW, 2);
  assert.deepEqual(
    picked.map((p) => `${p.found.mint}:${p.found.id}`),
    ["b:2", "b:5"],
    "the locked one (lockAt = now) and the unlisted coin are left out; the limit keeps the two soonest",
  );
  assert.equal(picked[0].coin.symbol, "B");
});

test("pickLive: coins from hidden creators never show", () => {
  const tester = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const hidden = hiddenCreators(` ${tester} ,not-an-address`);
  const picked = pickLive([found("a", "1", NOW + 1_000), found("t", "2", NOW + 500)], [coin("a"), coin("t", tester)], hidden, NOW);
  assert.deepEqual(picked.map((p) => p.found.mint), ["a"]);
});

test("toLivePrediction: points split from the pools (50/50 when empty), market odds from the pool", () => {
  assert.deepEqual(pointsProbability(0, 0), { yes: 0.5, no: 0.5 });
  const [points] = pickLive([found("a", "1", NOW + 1_000, { yes: 300, no: 100, bettors: 4 })], [coin("a")], new Set(), NOW);
  assert.deepEqual(toLivePrediction(points, { yes: 0.9, no: 0.1 }), {
    mint: "a",
    symbol: "A",
    name: "a coin",
    streamUrl: null,
    id: "1",
    text: "a 1?",
    lockAt: NOW + 1_000,
    kind: "points",
    probability: { yes: 0.75, no: 0.25 },
    points: 400,
    bettors: 4,
  });
  const [market] = pickLive([found("a", "2", NOW + 1_000, { market: true, yes: 5, no: 0 })], [coin("a")], new Set(), NOW);
  const card = toLivePrediction(market, { yes: 0.62, no: 0.38 });
  assert.equal(card.kind, "market");
  assert.deepEqual(card.probability, { yes: 0.62, no: 0.38 });
  assert.equal(card.points, null);
  assert.equal(toLivePrediction(market, null).probability, null, "an unread pool is unknown, never the points split");
});

test("home row links carry the question and side; the coin page reads them back, and nothing malformed", () => {
  const yes = predictionHref("MintA1", "7", "yes");
  assert.equal(yes, "/coin/MintA1?p=7&side=yes#predictions");
  assert.equal(predictionHref("MintA1", "7"), "/coin/MintA1?p=7#predictions");
  assert.deepEqual(predictionPick(new URL(yes, "https://x.test").search), { id: "7", side: "yes" });
  assert.deepEqual(predictionPick("?p=7"), { id: "7", side: null });
  assert.deepEqual(predictionPick("?p=7&side=maybe"), { id: "7", side: null }, "a bad side is dropped");
  for (const bad of ["", "?side=yes", "?p=", "?p=../x", `?p=${"9".repeat(41)}`, "?p=<script>"]) assert.equal(predictionPick(bad), null, bad);
});
