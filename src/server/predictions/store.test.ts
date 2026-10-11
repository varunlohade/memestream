import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFengari, luaRedis } from "./lua-harness";
import { type Commit, memoryStore, type PredictionStore, redisStore } from "./store";

/**
 * Every test runs on both stores: the in-memory one, and the Redis one with its real Lua scripts
 * run by the fengari Lua VM (a devDependency; see lua-harness.ts).
 */
const fengari = loadFengari();
/** A clock the tests can move (document expiry). */
const clock = { t: 1_000_000 };
const STORES: [string, () => PredictionStore, { skip?: string }][] = [
  ["memory", () => memoryStore(() => clock.t), {}],
  ["redis+lua", () => redisStore(luaRedis(fengari, () => clock.t)), {}],
];

const commit = (over: Partial<Commit>): Commit => ({ docs: [], moves: [], won: [], ...over });

for (const [name, make, options] of STORES) {
  test(`${name}: documents are versioned; a stale version is a conflict and writes nothing`, options, async () => {
    const store = make();
    assert.deepEqual(await store.read(["coin:a"]), [{ v: 0, json: null }]);
    assert.equal(await store.commit(commit({ docs: [{ key: "coin:a", v: 0, json: '{"n":1}' }], moves: [{ wallet: "w", delta: 5, floor: 0 }] })), "ok");
    assert.deepEqual(await store.read(["coin:a", "coin:b"]), [{ v: 1, json: '{"n":1}' }, { v: 0, json: null }]);
    assert.equal(await store.commit(commit({ docs: [{ key: "coin:a", v: 0, json: '{"n":2}' }], moves: [{ wallet: "w", delta: 5, floor: 0 }] })), "conflict");
    assert.deepEqual(await store.read(["coin:a"]), [{ v: 1, json: '{"n":1}' }]);
    assert.deepEqual(await store.balances(["w", "nobody"]), [5, 0]);
  });

  test(`${name}: a nonce works once`, options, async () => {
    const store = make();
    const once = commit({ nonce: { key: "nonce:w:abc", ttlMs: 60_000 } });
    assert.equal(await store.commit(once), "ok");
    assert.equal(await store.commit(once), "replay");
  });

  test(`${name}: a refused commit does not use up its nonce`, options, async () => {
    const store = make();
    const nonce = { key: "act:refused", ttlMs: 60_000 };
    const spend = commit({ docs: [{ key: "coin:n", v: 0, json: "1" }], moves: [{ wallet: "w", delta: -10, floor: 20 }], nonce });
    assert.equal(await store.commit(spend), "insufficient");
    await store.commit(commit({ moves: [{ wallet: "w", delta: 20, floor: 0 }] }));
    assert.equal(await store.commit(commit({ ...spend, docs: [{ key: "coin:n", v: 7, json: "1" }] })), "conflict");
    assert.equal(await store.commit(spend), "ok", "the same nonce still works after insufficient and conflict");
    assert.deepEqual(await store.balances(["w"]), [10]);
  });

  test(`${name}: a commit re-sent after it landed answers "replay", not "conflict", and moves nothing`, options, async () => {
    const store = make();
    await store.commit(commit({ moves: [{ wallet: "w", delta: 100, floor: 0 }] }));
    const bet = commit({ docs: [{ key: "coin:r", v: 0, json: "bet" }], moves: [{ wallet: "w", delta: -30, floor: 60 }], nonce: { key: "act:once", ttlMs: 60_000 } });
    assert.equal(await store.commit(bet), "ok");
    assert.equal(await store.commit(bet), "replay");
    assert.deepEqual(await store.balances(["w"]), [70]);
    assert.deepEqual(await store.read(["coin:r"]), [{ v: 1, json: "bet" }]);
  });

  test(`${name}: balance floors and the zero floor are checked before anything moves`, options, async () => {
    const store = make();
    await store.commit(commit({ moves: [{ wallet: "a", delta: 100, floor: 0 }] }));
    // A bet of 60 needs a balance of at least 120 (at most half): refused, and nothing else moves.
    const bet = commit({ moves: [{ wallet: "b", delta: 7, floor: 0 }, { wallet: "a", delta: -60, floor: 120 }] });
    assert.equal(await store.commit(bet), "insufficient");
    assert.deepEqual(await store.balances(["a", "b"]), [100, 0]);
    assert.equal(await store.commit(commit({ moves: [{ wallet: "a", delta: -101, floor: 0 }] })), "insufficient");
    assert.equal(await store.commit(commit({ moves: [{ wallet: "a", delta: -50, floor: 100 }] })), "ok");
    assert.deepEqual(await store.balances(["a"]), [50]);
  });

  test(`${name}: parallel spends from one wallet never overdraw it`, options, async () => {
    const store = make();
    await store.commit(commit({ moves: [{ wallet: "w", delta: 1_000, floor: 0 }] }));
    const results = await Promise.all(Array.from({ length: 200 }, () => store.commit(commit({ moves: [{ wallet: "w", delta: -30, floor: 60 }] }))));
    const [balance] = await store.balances(["w"]);
    const spent = results.filter((r) => r === "ok").length;
    assert.ok(balance >= 0);
    assert.equal(balance, 1_000 - 30 * spent, "every accepted spend is counted once");
    assert.ok(balance < 60, "spends stop only when the floor is reached");
  });

  test(`${name}: parallel writers to one document: exactly one wins each version`, options, async () => {
    const store = make();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.commit(commit({ docs: [{ key: "coin:x", v: 0, json: String(i) }], moves: [{ wallet: "w", delta: 1, floor: 0 }] }))),
    );
    assert.equal(results.filter((r) => r === "ok").length, 1);
    assert.deepEqual(await store.balances(["w"]), [1], "the losers moved no points");
  });

  test(`${name}: all-time winnings feed the leaderboard, highest first`, options, async () => {
    const store = make();
    await store.commit(commit({ won: [{ wallet: "a", delta: 120 }, { wallet: "b", delta: -40 }, { wallet: "c", delta: 300 }] }));
    await store.commit(commit({ won: [{ wallet: "a", delta: 200 }] }));
    assert.deepEqual(await store.topWon(2), [{ wallet: "a", points: 320 }, { wallet: "c", points: 300 }]);
  });

  test(`${name}: a document with a time to live reads as new once it expires`, options, async () => {
    const store = make();
    const start = clock.t;
    assert.equal(await store.commit(commit({ docs: [{ key: "ip:x", v: 0, json: "[1]", ttlMs: 1_000 }] })), "ok");
    assert.deepEqual(await store.read(["ip:x"]), [{ v: 1, json: "[1]" }]);
    clock.t = start + 1_000;
    assert.deepEqual(await store.read(["ip:x"]), [{ v: 0, json: null }]);
    assert.equal(await store.commit(commit({ docs: [{ key: "ip:x", v: 0, json: "[2]", ttlMs: 1_000 }] })), "ok", "starts over at version 0");
  });

  test(`${name}: leaderboard ties are ordered the same way in both stores (wallet, high to low)`, options, async () => {
    const store = make();
    await store.commit(commit({ won: [{ wallet: "aaa", delta: 50 }, { wallet: "ccc", delta: 50 }, { wallet: "bbb", delta: 50 }, { wallet: "zzz", delta: 10 }] }));
    assert.deepEqual((await store.topWon(4)).map((l) => l.wallet), ["ccc", "bbb", "aaa", "zzz"]);
  });
}
