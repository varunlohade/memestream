import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import bs58 from "bs58";
import { MESSAGE_TTL_MS, sessionMessage } from "@/lib/predictions/message";
import { newProfile } from "@/lib/predictions/watch";
import { walletFromToken } from "./identity";
import { loadFengari, luaRedis } from "./lua-harness";
import { ContentionError, predictionsService } from "./service";
import { memoryStore, type PredictionStore, redisStore } from "./store";

const MIN = 60_000;
const T0 = Date.parse("2026-10-09T12:00:00.000Z");
const SECRET = "test-secret-test-secret-test-secret";
const COIN = "coin";
const STREAMER = "streamer";

const fengari = loadFengari();
const STORES: [string, () => PredictionStore, { skip?: string }][] = [
  ["memory", () => memoryStore(), {}],
  ["redis+lua", () => redisStore(luaRedis(fengari)), fengari ? {} : { skip: "set LUA_TEST_DIR to run the Lua scripts" }],
];

function setup(make: () => PredictionStore) {
  const store = make();
  const clock = { t: T0 };
  const service = predictionsService({
    store,
    now: () => clock.t,
    secret: SECRET,
    creatorOf: async (mint) => (mint === COIN ? STREAMER : null),
    attempts: 200,
    backoffMs: () => Math.random() * 2,
  });
  /** Test-only funding: points and watch time, written straight to the store. */
  const fund = async (wallet: string, points: number, watchMinutes = 0) => {
    const profile = { ...newProfile(), watchMs: watchMinutes * MIN, starter: watchMinutes >= 10 };
    const [doc] = await store.read([`watch:${wallet}`]);
    await store.commit({ docs: [{ key: `watch:${wallet}`, v: doc.v, json: JSON.stringify(profile) }], moves: [{ wallet, delta: points, floor: 0 }], won: [] });
  };
  const balance = async (wallet: string) => (await store.balances([wallet]))[0];
  return { store, clock, service, fund, balance };
}

for (const [name, make, options] of STORES) {
  test(`${name}: sign in once; the token names the wallet; a used signature can't sign in again`, options, async () => {
    const { service } = setup(make);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const wallet = bs58.encode(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
    const message = sessionMessage({ wallet, nonce: "00112233445566778899aabbccddeeff", expiresAt: T0 + MESSAGE_TTL_MS });
    const signature = bs58.encode(sign(null, Buffer.from(message), privateKey));
    const session = await service.session(message, signature);
    assert.equal(walletFromToken(session.token, T0, SECRET), wallet);
    await assert.rejects(service.session(message, signature), /already used/);
  });

  test(`${name}: heartbeats: parallel beats from one wallet count once; the starter unlocks at 10 minutes`, options, async () => {
    const { service, clock, balance } = setup(make);
    const results = await Promise.all(Array.from({ length: 10 }, () => service.beat("viewer")));
    assert.equal(results.filter((r) => r.accepted).length, 1);
    assert.equal(await balance("viewer"), 2);
    for (let i = 1; i < 10; i++) {
      clock.t = T0 + i * MIN;
      await service.beat("viewer");
    }
    assert.equal(await balance("viewer"), 20 + 200);
    const view = await service.view(COIN, "viewer");
    assert.deepEqual([view.me?.watchMinutes, view.me?.starterInMinutes], [10, null]);
  });

  test(`${name}: the whole flow: suggest, upvote, crowd auto-launch, bet, resolve; points conserved`, options, async () => {
    const { service, clock, fund, balance } = setup(make);
    const viewers = ["v1", "v2", "v3", "v4", "v5", "v6"];
    for (const v of viewers) await fund(v, 1_000, 40);
    await fund("asker", 100, 40);

    await service.act(COIN, "asker", { kind: "suggest", text: "Will the streamer eat a banana?" });
    assert.equal(await balance("asker"), 90);
    for (const v of viewers.slice(0, 2)) await service.act(COIN, v, { kind: "upvote", id: "1" });
    assert.equal((await service.view(COIN, null)).live, null, "2 upvotes: still waiting");
    const launched = await service.act(COIN, "v3", { kind: "upvote", id: "1" });
    assert.equal(launched.live?.text, "Will the streamer eat a banana?");
    assert.equal(await balance("asker"), 100, "suggestion cost refunded on going live");

    await Promise.all(viewers.map((v, i) => service.act(COIN, v, { kind: "bet", side: i < 2 ? "yes" : "no", amount: 100 })));
    const before = (await Promise.all(viewers.map(balance))).reduce((a, b) => a + b, 0);
    assert.equal(before, 6 * 1_000 - 600);

    await assert.rejects(service.act(COIN, STREAMER, { kind: "resolve", outcome: "yes" }), /still open/);
    clock.t += 2 * MIN;
    const done = await service.act(COIN, STREAMER, { kind: "resolve", outcome: "yes" });
    const after = (await Promise.all(viewers.map(balance))).reduce((a, b) => a + b, 0);
    assert.equal(after, 6 * 1_000, "the pool goes back out in full");
    assert.deepEqual([await balance("v1"), await balance("v3")], [1_000 + 200, 1_000 - 100]);
    assert.equal(await balance("asker"), 100 + 50, "asker reward: YES with 6 eligible bettors");
    assert.deepEqual(done.resolved[0].resolvedBy, { role: "streamer", wallet: STREAMER });
    assert.deepEqual(done.leaderboard.stream, [{ wallet: "v1", points: 200 }, { wallet: "v2", points: 200 }]);
  });

  test(`${name}: many viewers betting at once: every accepted bet is debited once and counted in the pool`, options, async () => {
    const { service, fund, balance } = setup(make);
    const viewers = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, "0")}`);
    for (const v of viewers) await fund(v, 200);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 5 });
    const results = await Promise.allSettled(viewers.map((v, i) => service.act(COIN, v, { kind: "bet", side: i % 2 ? "yes" : "no", amount: 50 })));
    const accepted = viewers.filter((_, i) => results[i].status === "fulfilled");
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof ContentionError, String(r.reason));
    const view = await service.view(COIN, null);
    assert.equal(view.live!.yes + view.live!.no, 50 * accepted.length);
    assert.equal(view.live!.bettors, accepted.length);
    for (const v of viewers) assert.equal(await balance(v), accepted.includes(v) ? 150 : 200);
  });

  test(`${name}: one wallet betting in parallel never breaks "at most half your points"`, options, async () => {
    const { service, fund, balance } = setup(make);
    await fund("w", 100);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 5 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.act(COIN, "w", { kind: "bet", side: "yes", amount: 10 })));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    // Each bet of 10 needs at least 20 before it: 100, 90, ... 20 -> 9 bets, 10 left.
    assert.equal(ok, 9);
    assert.equal(await balance("w"), 10);
    const view = await service.view(COIN, "w");
    assert.deepEqual(view.live?.myBet, { side: "yes", amount: 90 });
  });

  test(`${name}: auto-cancel refunds everyone after 60 minutes unresolved`, options, async () => {
    const { service, clock, fund, balance } = setup(make);
    await fund("a", 500);
    await fund("b", 500);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 1 });
    await service.act(COIN, "a", { kind: "bet", side: "yes", amount: 200 });
    await service.act(COIN, "b", { kind: "bet", side: "no", amount: 100 });
    clock.t += 61 * MIN;
    const view = await service.view(COIN, "a");
    assert.deepEqual(view.resolved[0].resolvedBy, { role: "auto", wallet: null });
    assert.equal(view.resolved[0].outcome, "cancel");
    assert.deepEqual([await balance("a"), await balance("b")], [500, 500]);
  });

  test(`${name}: leaderboards list only wallets with 30+ minutes watched; unknown coins are refused`, options, async () => {
    const { service, clock, fund } = setup(make);
    await fund("watcher", 500, 30);
    await fund("drive-by", 500, 5);
    await fund("loser", 500, 30);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 1 });
    await service.act(COIN, "watcher", { kind: "bet", side: "yes", amount: 100 });
    await service.act(COIN, "drive-by", { kind: "bet", side: "yes", amount: 200 });
    await service.act(COIN, "loser", { kind: "bet", side: "no", amount: 150 });
    clock.t += MIN;
    const view = await service.act(COIN, STREAMER, { kind: "resolve", outcome: "yes" });
    assert.deepEqual(view.leaderboard.stream, [{ wallet: "watcher", points: 50 }], "drive-by won more but watched 5 minutes; losers aren't on the top line");
    assert.deepEqual(view.leaderboard.allTime, [{ wallet: "watcher", points: 50 }]);
    const loser = await service.view(COIN, "loser");
    assert.deepEqual(loser.leaderboard.me.stream, { points: -150, rank: 2 });
    await assert.rejects(service.view("not-a-coin", null), /Coin not found/);
  });
}
