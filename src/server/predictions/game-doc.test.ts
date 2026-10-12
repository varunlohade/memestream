import assert from "node:assert/strict";
import { test } from "node:test";
import { type Game, newGame, type Prediction, type Summary } from "@/lib/predictions/engine";
import { MAX_LIVE } from "@/lib/predictions/rules";
import { gameKeys, loadGame, RESULT_DOCS } from "./game-doc";
import { memoryStore } from "./store";

const MINT = "mint";
const prediction = (id: string): Prediction => ({
  id,
  text: `Will chat win round ${id}?`,
  asker: null,
  launchedAt: 1,
  lockAt: 2,
  launchedBy: "s",
  bets: { a: { side: "yes", amount: 10, eligible: false } },
  yes: 10,
  no: 0,
  bettors: 1,
});
const docsFor = (coin: unknown) => [{ v: 3, json: coin === undefined ? null : JSON.stringify(coin) }, ...Array.from({ length: MAX_LIVE + RESULT_DOCS }, () => ({ v: 0, json: null }))];
const result = (id: string, open: boolean): Summary => ({
  id,
  text: `Result ${id}?`,
  asker: null,
  outcome: "yes",
  yes: 10,
  no: 10,
  bettors: 2,
  resolvedAt: 1,
  resolvedBy: "s",
  askerReward: 0,
  flags: 0,
  disputed: false,
  open: open ? { results: { a: [10, 20, 0], b: [10, 0, 1] }, eligible: 1 } : null,
});

/** Saves `next` over what `store` holds, then reads the game back. */
async function roundTrip(store: ReturnType<typeof memoryStore>, next: (game: Game) => Game) {
  const loaded = loadGame(MINT, await store.read(gameKeys(MINT)), "s");
  const docs = loaded.save(next(loaded.game));
  assert.equal(await store.commit({ docs, moves: [], won: [] }), "ok");
  return { docs, game: loadGame(MINT, await store.read(gameKeys(MINT)), "s").game };
}

test("old documents migrate: `live: X` loads as [X], `live: null` as []", () => {
  const x = prediction("7");
  assert.deepEqual(loadGame(MINT, docsFor({ ...newGame("s"), live: x }), "s").game.live, [x]);
  assert.deepEqual(loadGame(MINT, docsFor({ ...newGame("s"), live: null }), "s").game.live, []);
  assert.deepEqual(loadGame(MINT, docsFor(undefined), "s").game.live, []);
  assert.deepEqual(loadGame(MINT, docsFor({ ...newGame("s"), live: [x] }), "s").game.live, [x], "the short-lived inline list too");

  // On its next save the old prediction moves into its own slot; the coin document keeps a short entry.
  const old = loadGame(MINT, docsFor({ ...newGame("s"), live: x }), "s");
  const docs = old.save(old.game);
  assert.deepEqual(docs.map((d) => [d.key, d.v]), [[`coin:${MINT}`, 3], [`coin:${MINT}:p:0`, 0]]);
  assert.deepEqual(JSON.parse(docs[0].json!).live, [{ id: "7", slot: 0, text: x.text, lockAt: 2 }]);
  assert.deepEqual(JSON.parse(docs[1].json!), x);
});

test("each live prediction keeps its slot; a resolved one's document is deleted; a new one takes the first free slot", async () => {
  const store = memoryStore();
  const [a, b, c, d] = ["1", "2", "3", "4"].map(prediction);
  let saved = await roundTrip(store, (g) => ({ ...g, live: [a, b, c] }));
  assert.deepEqual(saved.game.live, [a, b, c]);
  assert.ok(!saved.docs[0].json!.includes('"bets"'), "bets live only in the slot documents");

  const betOnB = { ...b, yes: 20, bets: { ...b.bets, z: { side: "yes" as const, amount: 10, eligible: false } } };
  saved = await roundTrip(store, (g) => ({ ...g, live: [a, betOnB, c] }));
  assert.deepEqual(saved.docs.map((x) => x.key), [`coin:${MINT}`, `coin:${MINT}:p:1`], "only the changed slot is written");

  saved = await roundTrip(store, (g) => ({ ...g, live: [betOnB, c, d] }));
  assert.deepEqual(
    saved.docs.map((x) => [x.key, x.json === null ? null : JSON.parse(x.json).id ?? "coin"]),
    [[`coin:${MINT}`, "coin"], [`coin:${MINT}:p:0`, "4"]],
    "a's slot goes straight to d",
  );
  assert.deepEqual(saved.game.live, [betOnB, c, d]);

  saved = await roundTrip(store, (g) => ({ ...g, live: [d] }));
  assert.deepEqual(saved.docs.slice(1).map((x) => [x.key, x.json]), [[`coin:${MINT}:p:1`, null], [`coin:${MINT}:p:2`, null]], "resolved ones are deleted");
  assert.deepEqual((await store.read(gameKeys(MINT))).filter((x) => x.json !== null).length, 2, "the coin document and d's slot");
});

test("flag-window lists live in the results documents, not the coin document, and load back in place", async () => {
  const store = memoryStore();
  const results = [result("9", true), result("8", false), result("7", true)];
  // An old coin document with the lists inline moves them out on its next save.
  const old = loadGame(MINT, docsFor({ ...newGame("s"), resolved: results }), "s");
  assert.deepEqual(old.game.resolved, results);
  const saved = await roundTrip(store, () => old.game);
  const coin = JSON.parse(saved.docs[0].json!);
  assert.deepEqual(coin.resolved.map((r: Summary) => r.open), [{ results: {}, eligible: 1 }, null, { results: {}, eligible: 1 }]);
  assert.deepEqual(saved.docs.slice(1).map((d) => [d.key, JSON.parse(d.json!)]), [[`coin:${MINT}:r:0`, { "9": results[0].open!.results, "7": results[2].open!.results }]]);
  assert.deepEqual(saved.game.resolved, results);

  // Unchanged: the same text, so nothing but the coin document is written.
  assert.deepEqual((await roundTrip(store, (g) => g)).docs.map((d) => d.key), [`coin:${MINT}`]);
  // Both windows close: the results document goes.
  const closed = await roundTrip(store, (g) => ({ ...g, resolved: g.resolved.map((r) => ({ ...r, open: null })) }));
  assert.deepEqual(closed.docs.slice(1).map((d) => [d.key, d.json]), [[`coin:${MINT}:r:0`, null]]);
});
