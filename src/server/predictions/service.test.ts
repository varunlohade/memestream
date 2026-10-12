import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import bs58 from "bs58";
import { MESSAGE_TTL_MS, sessionMessage } from "@/lib/predictions/message";
import { FLAG_WINDOW_MS } from "@/lib/predictions/rules";
import { newProfile, utcDay } from "@/lib/predictions/watch";
import { walletFromToken } from "./identity";
import { jevAnswer } from "./jev-fake";
import { loadFengari, luaRedis } from "./lua-harness";
import { type CoinFacts, ContentionError, ipBucket, predictionsService } from "./service";
import { reviewClient } from "./review";
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

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fake jev behind a fake fetch (no test reaches the real API). `answer` makes each response;
 * `key` is the configured TYPESAFE_API_KEY.
 */
function fakeJev() {
  const jev = {
    calls: 0,
    key: "test-key" as string | undefined,
    answer: ((() => jsonResponse(jevAnswer("APPROVE"))) as (signal: AbortSignal) => Response | Promise<Response>),
  };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    jev.calls += 1;
    return jev.answer(init!.signal!);
  };
  const review = (question: string) => reviewClient({ apiKey: jev.key, fetch, sleep: async () => {}, timeoutMs: 20 })(question);
  return { jev, review };
}

/**
 * The service on a store, with a fake clock and a fake jev. Tasks run "after the response" are
 * held; `settle()` runs them and waits. With `autoReview` (the default), every action waits for
 * its reviews before returning, so typed questions are approved at once.
 */
function setup(make: (clock: Clock) => PredictionStore, { autoReview = true } = {}) {
  const clock = { t: T0 };
  const store = make(clock);
  const coins = new Map<string, CoinFacts>([[COIN, { creator: STREAMER, status: "trading" }]]);
  /** Wallets that hold the coin (everyone, unless removed). */
  const nonHolders = new Set<string>();
  const { jev, review } = fakeJev();
  const deferred: (() => Promise<void>)[] = [];
  const raw = predictionsService({
    store,
    now: () => clock.t,
    secret: SECRET,
    domain: DOMAIN,
    coin: async (mint) => coins.get(mint) ?? null,
    holds: async (_mint, wallet) => !nonHolders.has(wallet),
    review,
    defer: (task) => void deferred.push(task),
    attempts: 200,
    backoffMs: () => Math.random() * 2,
  });
  const settle = async () => {
    while (deferred.length) await Promise.all(deferred.splice(0).map((task) => task()));
  };
  const service: typeof raw = !autoReview
    ? raw
    : {
        ...raw,
        act: async (mint, wallet, action) => {
          const view = await raw.act(mint, wallet, action);
          if (deferred.length === 0) return view;
          await settle();
          return view && raw.view(mint, wallet);
        },
      };
  /** Test-only funding: points and watch time, written straight to the store. */
  const fund = async (wallet: string, points: number, watchMinutes = 0) => {
    const profile = { ...newProfile(), watchMs: watchMinutes * MIN, earningMs: watchMinutes * MIN, starter: watchMinutes >= 10 };
    const [doc] = await store.read([`watch:${wallet}`]);
    await store.commit({ docs: [{ key: `watch:${wallet}`, v: doc.v, json: JSON.stringify(profile) }], moves: [{ wallet, delta: points, floor: 0 }], won: [] });
  };
  const balance = async (wallet: string) => (await store.balances([wallet]))[0];
  /** The streamer watching their own coin (needed for crowd auto-launch). */
  const streamerHere = () => service.beat(STREAMER, COIN, "10.0.0.1");
  /** The oldest live prediction's id. */
  const liveId = async () => (await service.view(COIN, STREAMER)).live[0].id;
  return { store, clock, service, fund, balance, coins, nonHolders, streamerHere, jev, settle, liveId };
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const wallet = bs58.encode(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
  return { wallet, sign: (text: string) => bs58.encode(sign(null, Buffer.from(text), privateKey)) };
}

test("ipBucket: IPv4 whole; IPv6 by its /64 prefix, however it is written", () => {
  assert.equal(ipBucket("9.9.9.9"), "9.9.9.9");
  assert.equal(ipBucket("::ffff:9.9.9.9"), "9.9.9.9");
  const home = "2001:db8:1:2::/64";
  for (const ip of ["2001:db8:1:2::1", "2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd", "[2001:db8:1:2:ffff::]", "2001:db8:1:2::1%eth0", "2001:db8:1:2:0:0:1.2.3.4"]) {
    assert.equal(ipBucket(ip), home, ip);
  }
  assert.equal(ipBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipBucket("::1"), "0:0:0:0::/64");
  assert.notEqual(ipBucket("2001:db8:1:3::1"), home);
});

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

  test(`${name}: a wallet over the per-IP cap can't watch its way to eligible upvotes`, async () => {
    const { service, clock } = setup(make);
    const wallets = ["w1", "w2", "w3", "w4", "w5", "sybil"];
    for (let i = 0; i < 15; i++) {
      clock.t = T0 + i * MIN;
      for (const w of wallets) await service.beat(w, COIN, "9.9.9.9");
    }
    const [earner, sybil] = await Promise.all([service.view(COIN, "w1"), service.view(COIN, "sybil")]);
    assert.deepEqual([earner.me?.watchMinutes, earner.me?.eligible], [15, true]);
    assert.deepEqual([sybil.me?.watchMinutes, sybil.me?.eligible], [15, false]);
    await service.act(COIN, "w1", { kind: "suggest", text: "Will the streamer eat a banana?" });
    await assert.rejects(service.act(COIN, "sybil", { kind: "upvote", id: "1" }), /Watch 15 minutes to upvote/);
  });

  test(`${name}: IPv6: the 5-wallet cap counts a whole /64 as one IP`, async () => {
    const { service, balance, store } = setup(make);
    const wallets = ["w1", "w2", "w3", "w4", "w5", "w6"];
    for (const [i, w] of wallets.entries()) assert.equal((await service.beat(w, COIN, `2001:db8:1:2::${i + 1}`)).accepted, true);
    assert.deepEqual(await Promise.all(wallets.map(balance)), [2, 2, 2, 2, 2, 0]);
    assert.equal((await service.beat("w7", COIN, "2001:db8:1:3::1")).points, 2, "another /64 is another IP");
    const hash = createHmac("sha256", SECRET).update("ip:2001:db8:1:2::/64").digest("base64url").slice(0, 22);
    const [doc] = await store.read([`ip:${hash}:${utcDay(T0)}`]);
    assert.deepEqual(JSON.parse(doc.json!), wallets.slice(0, 5), "stored under the labelled (\"ip:\") keyed hash of the /64");
  });

  test(`${name}: the whole flow: holders suggest and upvote; the crowd launches only while the streamer is here`, async () => {
    const { service, clock, fund, balance, nonHolders, streamerHere } = setup(make);
    const viewers = ["v1", "v2", "v3", "v4", "v5", "v6"];
    for (const v of viewers) await fund(v, 1_000, 40);
    await fund("asker", 100, 40);
    await fund("outsider", 100, 40);
    nonHolders.add("outsider");

    await assert.rejects(service.act(COIN, "outsider", { kind: "suggest", text: "Will the streamer eat a banana?" }), /Hold at least 1 of this coin/);
    assert.deepEqual(
      [(await service.view(COIN, "outsider")).me?.holder, (await service.view(COIN, "v1")).me?.holder, (await service.view(COIN, STREAMER)).me?.holder],
      [false, true, null],
      "the panel knows when to turn suggest and upvote off",
    );
    await service.act(COIN, "asker", { kind: "suggest", text: "Will the streamer eat a banana?" });
    assert.equal(await balance("asker"), 90);
    await assert.rejects(service.act(COIN, "outsider", { kind: "upvote", id: "1" }), /Hold at least 1 of this coin/);
    for (const v of viewers.slice(0, 3)) await service.act(COIN, v, { kind: "upvote", id: "1" });
    let view = await service.view(COIN, null);
    assert.deepEqual([view.live, view.streamerHere, view.queue[0].upvotes], [[], false, 3], "streamer away: it waits");

    await streamerHere();
    clock.t += 2_000; // past the signed-out view's 1.5 s cache
    view = await service.view(COIN, null);
    assert.equal(view.live[0]?.text, "Will the streamer eat a banana?");
    const id = view.live[0].id;
    assert.equal(await balance("asker"), 100, "suggestion cost refunded on going live");

    await Promise.all(viewers.map((v, i) => service.act(COIN, v, { kind: "bet", id, side: i < 2 ? "yes" : "no", amount: 100 })));
    await assert.rejects(service.act(COIN, STREAMER, { kind: "resolve", id, outcome: "yes" }), /still open/);
    clock.t += 2 * MIN;
    const done = (await service.act(COIN, STREAMER, { kind: "resolve", id, outcome: "yes" }))!;
    const after = (await Promise.all(viewers.map(balance))).reduce((a, b) => a + b, 0);
    assert.equal(after, 6 * 1_000, "the pool goes back out in full");
    assert.deepEqual([await balance("v1"), await balance("v3")], [1_000 + 200, 1_000 - 100]);
    assert.deepEqual(done.resolved[0].resolvedBy, { role: "streamer", wallet: STREAMER }, "staff see the wallet");
    assert.deepEqual([done.leaderboard.stream, await balance("asker")], [[], 100], "nothing counts during the flag window");

    clock.t += FLAG_WINDOW_MS;
    const counted = await service.view(COIN, "v1");
    assert.equal(await balance("asker"), 100 + 50, "asker reward: YES, 6 eligible bettors, not disputed");
    assert.deepEqual(counted.leaderboard.stream, [{ wallet: "v2", points: 200 }, { wallet: "v1", points: 200 }]);
    assert.deepEqual(counted.leaderboard.me.stream, { points: 200, rank: 2 });
  });

  test(`${name}: a commit whose reply is lost and is re-sent (Upstash SDK retry) counts the bet once`, async () => {
    const { store, service, fund, balance, liveId } = setup(make);
    await fund("V", 1_000);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will it rain today?", windowMin: 2 });
    const id = await liveId();
    // The first commit lands, its reply is lost, and the client re-sends the same eval.
    const commit = store.commit.bind(store);
    let loseNext = true;
    store.commit = async (c) => {
      const result = await commit(c);
      if (loseNext && result === "ok") {
        loseNext = false;
        return commit(c);
      }
      return result;
    };
    const view = await service.act(COIN, "V", { kind: "bet", id, side: "yes", amount: 100 });
    assert.equal(loseNext, false, "the re-send happened");
    assert.deepEqual(view?.live[0]?.myBet, { side: "yes", amount: 100 });
    assert.equal(await balance("V"), 900);
  });

  test(`${name}: an action saved before its view fails to load still succeeds (null view)`, async () => {
    const { store, service, fund, balance, liveId } = setup(make);
    await fund("V", 1_000);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will it rain today?", windowMin: 2 });
    const id = await liveId();
    const commit = store.commit.bind(store);
    const read = store.read.bind(store);
    let committed = false;
    store.commit = async (c) => {
      const result = await commit(c);
      committed ||= result === "ok";
      return result;
    };
    store.read = async (keys) => {
      if (committed) throw new Error("network down");
      return read(keys);
    };
    assert.equal(await service.act(COIN, "V", { kind: "bet", id, side: "yes", amount: 100 }), null);
    assert.equal(await balance("V"), 900, "the bet was saved once");
  });

  test(`${name}: many viewers betting at once: every accepted bet is debited once and counted in the pool`, async () => {
    const { service, fund, balance, liveId } = setup(make);
    const viewers = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, "0")}`);
    for (const v of viewers) await fund(v, 200);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 5 });
    const id = await liveId();
    const results = await Promise.allSettled(viewers.map((v, i) => service.act(COIN, v, { kind: "bet", id, side: i % 2 ? "yes" : "no", amount: 50 })));
    const accepted = viewers.filter((_, i) => results[i].status === "fulfilled");
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof ContentionError, String(r.reason));
    const view = await service.view(COIN, null);
    assert.equal(view.live[0].yes + view.live[0].no, 50 * accepted.length);
    assert.equal(view.live[0].bettors, accepted.length);
    for (const v of viewers) assert.equal(await balance(v), accepted.includes(v) ? 150 : 200);
  });

  test(`${name}: one wallet betting in parallel never breaks "at most half your points"`, async () => {
    const { service, fund, balance, liveId } = setup(make);
    await fund("w", 100);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 5 });
    const id = await liveId();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.act(COIN, "w", { kind: "bet", id, side: "yes", amount: 10 })));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    // Each bet of 10 needs at least 20 before it: 100, 90, ... 20 -> 9 bets, 10 left.
    assert.equal(ok, 9);
    assert.equal(await balance("w"), 10);
    assert.deepEqual((await service.view(COIN, "w")).live[0]?.myBet, { side: "yes", amount: 90 });
  });

  test(`${name}: one wallet betting in parallel on two live predictions never breaks "at most half your points"`, async () => {
    const { service, fund, balance } = setup(make);
    await fund("w", 100);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 5 });
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will the streamer jump?", windowMin: 5 });
    const ids = (await service.view(COIN, STREAMER)).live.map((p) => p.id);
    assert.equal(ids.length, 2);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => service.act(COIN, "w", { kind: "bet", id: ids[i % 2], side: "yes", amount: 10 })));
    // Each bet of 10 needs at least 20 before it, whichever prediction it is on: 9 bets, 10 left.
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 9);
    assert.equal(await balance("w"), 10);
    const mine = (await service.view(COIN, "w")).live.map((p) => p.myBet?.amount ?? 0);
    assert.equal(mine[0] + mine[1], 90, "every accepted bet counted once, on its own prediction");
  });

  test(`${name}: auto-cancel refunds everyone after 60 minutes unresolved`, async () => {
    const { service, clock, fund, balance, liveId } = setup(make);
    await fund("a", 500);
    await fund("b", 500);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 1 });
    const id = await liveId();
    await service.act(COIN, "a", { kind: "bet", id, side: "yes", amount: 200 });
    await service.act(COIN, "b", { kind: "bet", id, side: "no", amount: 100 });
    clock.t += 61 * MIN;
    const view = await service.view(COIN, "a");
    assert.deepEqual([view.resolved[0].outcome, view.resolved[0].resolvedBy], ["cancel", { role: "auto", wallet: null }]);
    assert.deepEqual([await balance("a"), await balance("b")], [500, 500]);
  });

  test(`${name}: leaderboards list only wallets with 30+ minutes watched; unknown coins are refused`, async () => {
    const { service, clock, fund, liveId } = setup(make);
    await fund("watcher", 500, 30);
    await fund("drive-by", 500, 5);
    await fund("loser", 500, 30);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 1 });
    const id = await liveId();
    await service.act(COIN, "watcher", { kind: "bet", id, side: "yes", amount: 100 });
    await service.act(COIN, "drive-by", { kind: "bet", id, side: "yes", amount: 200 });
    await service.act(COIN, "loser", { kind: "bet", id, side: "no", amount: 150 });
    clock.t += MIN;
    await service.act(COIN, STREAMER, { kind: "resolve", id, outcome: "yes" });
    clock.t += FLAG_WINDOW_MS;
    const view = await service.view(COIN, "loser");
    assert.deepEqual(view.leaderboard.stream, [{ wallet: "watcher", points: 50 }], "drive-by won more but watched 5 minutes; losers aren't on the top line");
    assert.deepEqual(view.leaderboard.allTime, [{ wallet: "watcher", points: 50 }]);
    assert.deepEqual(view.leaderboard.me.stream, { points: -150, rank: 2 });
    await assert.rejects(service.view("not-a-coin", null), /Coin not found/);
  });

  test(`${name}: the signed-out view is cached per coin for 1.5 s; signed-in views never are`, async () => {
    const { service, clock, fund } = setup(make);
    await fund("a", 500);
    const before = await service.view(COIN, null);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat win this round?", windowMin: 1 });
    clock.t += 1_000;
    const cached = await service.view(COIN, null);
    assert.deepEqual([cached.live, cached.now], [[], before.now + 1_000], "same data, current server time");
    assert.equal((await service.view(COIN, "a")).live[0]?.text, "Will chat win this round?");
    clock.t += 500;
    assert.equal((await service.view(COIN, null)).live[0]?.text, "Will chat win this round?");
  });

  test(`${name}: the streamer back after 2+ hours away starts a new stream: a fresh 20`, async () => {
    const { service, clock, streamerHere, liveId } = setup(make);
    await streamerHere();
    for (let i = 0; i < 20; i++) {
      await service.act(COIN, STREAMER, { kind: "launch", text: `Streamer question ${i}?`, windowMin: 1 });
      clock.t += MIN;
      await service.act(COIN, STREAMER, { kind: "resolve", id: await liveId(), outcome: "cancel" });
      await streamerHere();
    }
    await assert.rejects(service.act(COIN, STREAMER, { kind: "launch", text: "One more question?" }), /20 predictions/);
    clock.t += 119 * MIN;
    await streamerHere();
    await assert.rejects(service.act(COIN, STREAMER, { kind: "launch", text: "One more question?" }), /20 predictions/, "away under 2 hours: same stream");
    clock.t += 121 * MIN;
    await streamerHere();
    const fresh = (await service.act(COIN, STREAMER, { kind: "launch", text: "One more question?" }))!;
    assert.deepEqual([fresh.launched, fresh.resolved.length], [1, 5]);
  });

  test(`${name}: viewers see who resolved a prediction by role only; staff see the wallet`, async () => {
    const { service, clock, liveId } = setup(make);
    await service.act(COIN, STREAMER, { kind: "mod", wallet: "modwallet", add: true });
    await service.act(COIN, "modwallet", { kind: "launch", text: "Will chat win this round?", windowMin: 1 });
    clock.t += MIN;
    await service.act(COIN, "modwallet", { kind: "resolve", id: await liveId(), outcome: "cancel" });
    for (const who of [null, "viewer"]) {
      assert.deepEqual((await service.view(COIN, who)).resolved[0].resolvedBy, { role: "mod", wallet: null }, String(who));
    }
    for (const who of [STREAMER, "modwallet"]) {
      assert.deepEqual((await service.view(COIN, who)).resolved[0].resolvedBy, { role: "mod", wallet: "modwallet" }, who);
    }
  });

  test(`${name}: the GET view stays lean: top 20 suggestions, last 5 results, mods only for staff`, async () => {
    const { service, clock, fund, liveId } = setup(make);
    const askers = Array.from({ length: 25 }, (_, i) => `a${String(i).padStart(2, "0")}`);
    for (const a of askers) await fund(a, 100);
    for (const a of askers) await service.act(COIN, a, { kind: "suggest", text: `A question from ${a}?` });
    for (let i = 0; i < 6; i++) {
      await service.act(COIN, STREAMER, { kind: "launch", text: `Streamer question ${i}?`, windowMin: 1 });
      clock.t += MIN;
      await service.act(COIN, STREAMER, { kind: "resolve", id: await liveId(), outcome: "cancel" });
    }
    await service.act(COIN, STREAMER, { kind: "mod", wallet: "modwallet", add: true });
    const viewer = await service.view(COIN, "a00");
    assert.deepEqual([viewer.queueSize, viewer.queue.length, viewer.resolved.length, viewer.mods], [25, 20, 5, []]);
    assert.deepEqual((await service.view(COIN, STREAMER)).mods, ["modwallet"]);
  });
}

// ---------------------------------------------------------------------------------------------
// AI review (a fake jev behind a fake fetch).
// ---------------------------------------------------------------------------------------------

const SEC = 1_000;
const Q = "Will the streamer eat a banana?";

for (const [name, make] of STORES) {
  test(`${name}: review: a suggestion is under review for its asker only (no upvotes); approval shows it to everyone`, async () => {
    const { service, fund, settle, jev } = setup(make, { autoReview: false });
    await fund("asker", 100);
    await fund("other", 100, 30);
    const mine = (await service.act(COIN, "asker", { kind: "suggest", text: Q }))!;
    assert.deepEqual(mine.queue.map((s) => [s.text, s.status, s.mine]), [[Q, "review", true]]);
    const others = await service.view(COIN, "other");
    assert.deepEqual([others.queue, others.queueSize], [[], 0]);
    assert.deepEqual((await service.view(COIN, null)).queue, []);
    assert.deepEqual((await service.view(COIN, STREAMER)).queue, [], "not stuck: staff don't see it either");
    await assert.rejects(service.act(COIN, "other", { kind: "upvote", id: mine.queue[0].id }), /gone/);
    await settle();
    assert.equal(jev.calls, 1);
    const after = await service.view(COIN, "other");
    assert.deepEqual(after.queue.map((s) => [s.text, s.status]), [[Q, "ok"]]);
    await service.act(COIN, "other", { kind: "upvote", id: after.queue[0].id });
  });

  test(`${name}: review: a rejected suggestion leaves, its 10 points stay spent, and its asker sees why`, async () => {
    const { service, fund, settle, balance, jev } = setup(make, { autoReview: false });
    await fund("asker", 100);
    jev.answer = () => jsonResponse(jevAnswer("REJECT", 0.95, "HARASSMENT"));
    await service.act(COIN, "asker", { kind: "suggest", text: Q });
    assert.equal(await balance("asker"), 90);
    await settle();
    assert.equal(await balance("asker"), 90);
    const view = await service.view(COIN, "asker");
    assert.deepEqual([view.queue, view.me?.notice], [[], "Not approved: harassment"]);
    assert.equal((await service.view(COIN, "other")).me?.notice, null);
  });

  test(`${name}: review: a timeout keeps it under review; the next view after 5 s tries again and approves`, async () => {
    const { service, fund, settle, clock, jev } = setup(make, { autoReview: false });
    await fund("asker", 100);
    jev.answer = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    await service.act(COIN, "asker", { kind: "suggest", text: Q });
    await settle();
    assert.equal((await service.view(COIN, "asker")).queue[0].status, "review");
    jev.answer = () => jsonResponse(jevAnswer("APPROVE"));
    clock.t += 3 * SEC;
    await service.view(COIN, "asker");
    await settle();
    assert.equal(jev.calls, 1, "not again within 5 s");
    clock.t += 2 * SEC;
    await service.view(COIN, "asker");
    await settle();
    assert.equal(jev.calls, 2);
    assert.equal((await service.view(COIN, "other")).queue[0]?.status, "ok");
  });

  test(`${name}: review: a malformed answer or a missing key is a failure, never an approval; after 5 tries staff decide`, async () => {
    const { service, fund, settle, clock, jev, balance } = setup(make, { autoReview: false });
    await fund("asker", 100);
    jev.answer = () => jsonResponse({ answers: { verdict: { choice: "APPROVE", probabilities: { APPROVE: 1 }, confidence: 1 } } });
    await service.act(COIN, "asker", { kind: "suggest", text: Q });
    await settle();
    jev.key = undefined; // no TYPESAFE_API_KEY: no request goes out
    for (let i = 0; i < 6; i++) {
      clock.t += 15 * SEC;
      await service.view(COIN, "asker");
      await settle();
    }
    assert.equal(jev.calls, 1, "one malformed answer, then no key: nothing sent");
    const asker = await service.view(COIN, "asker");
    assert.deepEqual([asker.queue[0].status, asker.queue[0].stuck], ["review", true]);
    assert.deepEqual((await service.view(COIN, "other")).queue, [], "still hidden from viewers");
    const staff = await service.view(COIN, STREAMER);
    assert.deepEqual(staff.queue.map((s) => [s.status, s.stuck]), [["review", true]], "staff see the stuck one");
    await assert.rejects(service.act(COIN, "asker", { kind: "approve", id: staff.queue[0].id }), /Only the streamer/);
    await service.act(COIN, STREAMER, { kind: "remove", id: staff.queue[0].id });
    assert.equal(await balance("asker"), 100, "removed by hand: refunded");
    assert.equal((await service.view(COIN, "asker")).me?.notice, "Not approved by the streamer");
  });

  test(`${name}: review: a staff typed question waits under review (no bets), goes live on approval; a rejection uses no launch`, async () => {
    const { service, fund, settle } = setup(make, { autoReview: false });
    await fund("V", 1_000);
    const staff = (await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat hit 100?", windowMin: 2 }))!;
    assert.deepEqual([staff.live, staff.pending?.text, staff.pending?.stuck], [[], "Will chat hit 100?", false]);
    assert.equal((await service.view(COIN, "V")).pending, null, "viewers don't see it");
    await assert.rejects(service.act(COIN, "V", { kind: "bet", id: staff.pending!.id, side: "yes", amount: 10 }), /Betting is closed/);
    await settle();
    const live = await service.view(COIN, "V");
    assert.deepEqual([live.live[0]?.text, live.launched], ["Will chat hit 100?", 1]);

  });

  test(`${name}: review: a rejected staff question shows the reason to staff and leaves the launch count alone`, async () => {
    const { service, settle, jev } = setup(make, { autoReview: false });
    jev.answer = () => jsonResponse(jevAnswer("REJECT", 0.9, "VIOLENCE"));
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will chat fight someone?", windowMin: 2 });
    await settle();
    const staff = await service.view(COIN, STREAMER);
    assert.deepEqual([staff.live, staff.pending, staff.launched, staff.me?.notice], [[], null, 0, "Not approved: violent"]);
  });
}
