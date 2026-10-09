import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import bs58 from "bs58";
import { MESSAGE_TTL_MS, sessionMessage } from "@/lib/predictions/message";
import { FLAG_WINDOW_MS } from "@/lib/predictions/rules";
import { newProfile } from "@/lib/predictions/watch";
import { walletFromToken } from "./identity";
import { loadFengari, luaRedis } from "./lua-harness";
import { type CoinFacts, ContentionError, predictionsService } from "./service";
import { memoryStore, type PredictionStore, redisStore } from "./store";

const MIN = 60_000;
const T0 = Date.parse("2026-10-09T12:00:00.000Z");
const SECRET = "test-secret-test-secret-test-secret";
const DOMAIN = "memestream.lol";
const COIN = "coin";
const STREAMER = "streamer";

const fengari = loadFengari();
type Clock = { t: number };
const STORES: [string, (clock: Clock) => PredictionStore][] = [
  ["memory", (clock) => memoryStore(() => clock.t)],
  ["redis+lua", (clock) => redisStore(luaRedis(fengari, () => clock.t))],
];

function setup(make: (clock: Clock) => PredictionStore) {
  const clock = { t: T0 };
  const store = make(clock);
  const coins = new Map<string, CoinFacts>([[COIN, { creator: STREAMER, status: "trading" }]]);
  /** Wallets that hold the coin (everyone, unless removed). */
  const nonHolders = new Set<string>();
  const service = predictionsService({
    store,
    now: () => clock.t,
    secret: SECRET,
    domain: DOMAIN,
    coin: async (mint) => coins.get(mint) ?? null,
    holds: async (_mint, wallet) => !nonHolders.has(wallet),
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
  /** The streamer watching their own coin (needed for crowd auto-launch). */
  const streamerHere = () => service.beat(STREAMER, COIN, "10.0.0.1");
  return { store, clock, service, fund, balance, coins, nonHolders, streamerHere };
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const wallet = bs58.encode(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
  return { wallet, sign: (text: string) => bs58.encode(sign(null, Buffer.from(text), privateKey)) };
}

for (const [name, make] of STORES) {
  test(`${name}: sign in once for this domain; the token names the wallet; a used signature can't sign in again`, async () => {
    const { service } = setup(make);
    const me = keypair();
    const message = sessionMessage({ domain: DOMAIN, wallet: me.wallet, nonce: "00112233445566778899aabbccddeeff", expiresAt: T0 + MESSAGE_TTL_MS });
    const session = await service.session(message, me.sign(message));
    assert.equal(walletFromToken(session.token, T0, SECRET), me.wallet);
    await assert.rejects(service.session(message, me.sign(message)), /already used/);
    const elsewhere = sessionMessage({ domain: "evil.example", wallet: me.wallet, nonce: "ffeeddccbbaa99887766554433221100", expiresAt: T0 + MESSAGE_TTL_MS });
    await assert.rejects(service.session(elsewhere, me.sign(elsewhere)), /another site/);
  });

  test(`${name}: heartbeats: parallel beats from one wallet count once; the starter unlocks at 10 minutes`, async () => {
    const { service, clock, balance } = setup(make);
    const results = await Promise.all(Array.from({ length: 10 }, () => service.beat("viewer", COIN, "1.2.3.4")));
    assert.equal(results.filter((r) => r.accepted).length, 1);
    assert.equal(await balance("viewer"), 2);
    for (let i = 1; i < 10; i++) {
      clock.t = T0 + i * MIN;
      await service.beat("viewer", COIN, "1.2.3.4");
    }
    assert.equal(await balance("viewer"), 20 + 200);
    const view = await service.view(COIN, "viewer");
    assert.deepEqual([view.me?.watchMinutes, view.me?.starterInMinutes], [10, null]);
  });

  test(`${name}: heartbeats count only on a memestream coin that is trading or graduated`, async () => {
    const { service, coins, balance } = setup(make);
    await assert.rejects(service.beat("viewer", "not-a-coin", "1.2.3.4"), /Coin not found/);
    coins.set("full", { creator: STREAMER, status: "graduating" });
    assert.deepEqual(await service.beat("viewer", "full", "1.2.3.4"), { accepted: false, points: 0 });
    coins.set("done", { creator: STREAMER, status: "graduated" });
    assert.deepEqual(await service.beat("viewer", "done", "1.2.3.4"), { accepted: true, points: 2 });
    assert.equal(await balance("viewer"), 2);
  });

  test(`${name}: only 5 wallets per IP per day earn watch points; the 6th earns 0 silently; the next day resets`, async () => {
    const { service, clock, balance } = setup(make);
    const wallets = ["w1", "w2", "w3", "w4", "w5", "w6"];
    for (const w of wallets) assert.equal((await service.beat(w, COIN, "9.9.9.9")).accepted, true);
    assert.deepEqual(await Promise.all(wallets.map(balance)), [2, 2, 2, 2, 2, 0]);
    assert.equal((await service.beat("w6", COIN, "8.8.8.8")).points, 0, "too soon after its last beat");
    clock.t = T0 + MIN;
    assert.equal((await service.beat("w1", COIN, "9.9.9.9")).points, 2, "the first five keep earning");
    clock.t = Date.parse("2026-10-10T00:01:00.000Z");
    assert.equal((await service.beat("w6", COIN, "9.9.9.9")).points, 2, "a new day");
  });

  test(`${name}: the whole flow: holders suggest and upvote; the crowd launches only while the streamer is here`, async () => {
    const { service, clock, fund, balance, nonHolders, streamerHere } = setup(make);
    const viewers = ["v1", "v2", "v3", "v4", "v5", "v6"];
    for (const v of viewers) await fund(v, 1_000, 40);
    await fund("asker", 100, 40);
    await fund("outsider", 100, 40);
    nonHolders.add("outsider");

    await assert.rejects(service.act(COIN, "outsider", { kind: "suggest", text: "Will the streamer eat a banana?" }), /Hold this coin/);
    await service.act(COIN, "asker", { kind: "suggest", text: "Will the streamer eat a banana?" });
    assert.equal(await balance("asker"), 90);
    await assert.rejects(service.act(COIN, "outsider", { kind: "upvote", id: "1" }), /Hold this coin/);
    for (const v of viewers.slice(0, 3)) await service.act(COIN, v, { kind: "upvote", id: "1" });
    let view = await service.view(COIN, null);
    assert.deepEqual([view.live, view.streamerHere, view.queue[0].upvotes], [null, false, 3], "streamer away: it waits");

    await streamerHere();
    view = await service.view(COIN, null);
    assert.equal(view.live?.text, "Will the streamer eat a banana?");
    assert.equal(await balance("asker"), 100, "suggestion cost refunded on going live");

    await Promise.all(viewers.map((v, i) => service.act(COIN, v, { kind: "bet", side: i < 2 ? "yes" : "no", amount: 100 })));
    await assert.rejects(service.act(COIN, STREAMER, { kind: "resolve", outcome: "yes" }), /still open/);
    clock.t += 2 * MIN;
    const done = await service.act(COIN, STREAMER, { kind: "resolve", outcome: "yes" });
    const after = (await Promise.all(viewers.map(balance))).reduce((a, b) => a + b, 0);
    assert.equal(after, 6 * 1_000, "the pool goes back out in full");
    assert.deepEqual([await balance("v1"), await balance("v3")], [1_000 + 200, 1_000 - 100]);
    assert.deepEqual(done.resolved[0].resolvedBy, { role: "streamer", wallet: STREAMER });
    assert.deepEqual([done.leaderboard.stream, await balance("asker")], [[], 100], "nothing counts during the flag window");

    clock.t += FLAG_WINDOW_MS;
    const counted = await service.view(COIN, "v1");
    assert.equal(await balance("asker"), 100 + 50, "asker reward: YES, 6 eligible bettors, not disputed");
    assert.deepEqual(counted.leaderboard.stream, [{ wallet: "v2", points: 200 }, { wallet: "v1", points: 200 }]);
    assert.deepEqual(counted.leaderboard.me.stream, { points: 200, rank: 2 });
  });

  test(`${name}: many viewers betting at once: every accepted bet is debited once and counted in the pool`, async () => {
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

  test(`${name}: one wallet betting in parallel never breaks "at most half your points"`, async () => {
    const { service, fund, balance } = setup(make);
    await fund("w", 100);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 5 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.act(COIN, "w", { kind: "bet", side: "yes", amount: 10 })));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    // Each bet of 10 needs at least 20 before it: 100, 90, ... 20 -> 9 bets, 10 left.
    assert.equal(ok, 9);
    assert.equal(await balance("w"), 10);
    assert.deepEqual((await service.view(COIN, "w")).live?.myBet, { side: "yes", amount: 90 });
  });

  test(`${name}: auto-cancel refunds everyone after 60 minutes unresolved`, async () => {
    const { service, clock, fund, balance } = setup(make);
    await fund("a", 500);
    await fund("b", 500);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 1 });
    await service.act(COIN, "a", { kind: "bet", side: "yes", amount: 200 });
    await service.act(COIN, "b", { kind: "bet", side: "no", amount: 100 });
    clock.t += 61 * MIN;
    const view = await service.view(COIN, "a");
    assert.deepEqual([view.resolved[0].outcome, view.resolved[0].resolvedBy], ["cancel", { role: "auto", wallet: null }]);
    assert.deepEqual([await balance("a"), await balance("b")], [500, 500]);
  });

  test(`${name}: leaderboards list only wallets with 30+ minutes watched; unknown coins are refused`, async () => {
    const { service, clock, fund } = setup(make);
    await fund("watcher", 500, 30);
    await fund("drive-by", 500, 5);
    await fund("loser", 500, 30);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 1 });
    await service.act(COIN, "watcher", { kind: "bet", side: "yes", amount: 100 });
    await service.act(COIN, "drive-by", { kind: "bet", side: "yes", amount: 200 });
    await service.act(COIN, "loser", { kind: "bet", side: "no", amount: 150 });
    clock.t += MIN;
    await service.act(COIN, STREAMER, { kind: "resolve", outcome: "yes" });
    clock.t += FLAG_WINDOW_MS;
    const view = await service.view(COIN, "loser");
    assert.deepEqual(view.leaderboard.stream, [{ wallet: "watcher", points: 50 }], "drive-by won more but watched 5 minutes; losers aren't on the top line");
    assert.deepEqual(view.leaderboard.allTime, [{ wallet: "watcher", points: 50 }]);
    assert.deepEqual(view.leaderboard.me.stream, { points: -150, rank: 2 });
    await assert.rejects(service.view("not-a-coin", null), /Coin not found/);
  });

  test(`${name}: the GET view stays lean: top 20 suggestions, last 5 results, mods only for staff`, async () => {
    const { service, clock, fund } = setup(make);
    const askers = Array.from({ length: 25 }, (_, i) => `a${String(i).padStart(2, "0")}`);
    for (const a of askers) await fund(a, 100);
    for (const a of askers) await service.act(COIN, a, { kind: "suggest", text: `A question from ${a}?` });
    for (let i = 0; i < 6; i++) {
      await service.act(COIN, STREAMER, { kind: "launch", text: `Streamer question ${i}?`, windowMin: 1 });
      clock.t += MIN;
      await service.act(COIN, STREAMER, { kind: "resolve", outcome: "cancel" });
    }
    await service.act(COIN, STREAMER, { kind: "mod", wallet: "modwallet", add: true });
    const viewer = await service.view(COIN, "a00");
    assert.deepEqual([viewer.queueSize, viewer.queue.length, viewer.resolved.length, viewer.mods], [25, 20, 5, []]);
    assert.deepEqual((await service.view(COIN, STREAMER)).mods, ["modwallet"]);
  });
}
