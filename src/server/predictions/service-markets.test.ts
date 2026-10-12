import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketRecord } from "@/lib/markets/record";
import { CHALLENGE_BOND, FLAG_WINDOW_MS, MARKET_CHALLENGE_MS, MARKET_CREATE_MAX_TRIES, MARKET_FAILED_RETRY_MS, MARKET_RETRY_MS, OVERTURN_REWARD } from "@/lib/predictions/rules";
import { type MarketDeps, MarketUnavailable, predictionsService } from "./service";
import { memoryStore } from "./store";

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T12:00:00.000Z");
const COIN = "coin";
const STREAMER = "streamer";

/** A fake oracle: records every call; `fail` makes the next calls of a kind throw. */
function fakeMarkets() {
  const calls: string[] = [];
  const fail = { create: 0, close: 0, resolve: 0 };
  /** Wallets holding YES or NO shares. */
  const holders = new Set<string>();
  const deps: MarketDeps = {
    create: async (mint, id, symbol) => {
      calls.push(`create ${id} ${symbol}`);
      if (fail.create-- > 0) throw new Error("devnet said no");
      const record: Omit<MarketRecord, "lockAt" | "source"> = {
        mint,
        predictionId: id,
        oracle: "oracle",
        questionId: "00",
        question: `question-${id}`,
        vault: "vault",
        mints: { yes: "yes-mint", no: "no-mint" },
        pool: "pool",
        signature: "sig",
      };
      return record;
    },
    close: async (record) => {
      calls.push(`close ${record.predictionId}`);
      if (fail.close-- > 0) throw new Error("devnet said no");
    },
    resolve: async (record, outcome) => {
      calls.push(`resolve ${record.predictionId} ${outcome}`);
      if (fail.resolve-- > 0) throw new Error("devnet said no");
    },
    holdsShares: async (_record, wallet) => holders.has(wallet),
    redeemOracle: async (record) => {
      calls.push(`redeem ${record.predictionId}`);
    },
  };
  return { calls, fail, deps, holders };
}

const ADMIN = "admin1";

function setup(markets: MarketDeps | null, closeWaitMs = 0) {
  const clock = { t: T0 };
  const store = memoryStore(() => clock.t);
  const deferred: (() => Promise<void>)[] = [];
  const service = predictionsService({
    store,
    now: () => clock.t,
    secret: "test-secret-test-secret-test-secret",
    domain: "memestream.lol",
    coin: async () => ({ creator: STREAMER, status: "trading", symbol: "MIRA" }),
    holds: async () => true,
    review: async () => ({ approved: true }),
    defer: (task) => void deferred.push(task),
    markets,
    closeWaitMs,
    admins: [ADMIN],
  });
  const settle = async () => {
    while (deferred.length) await Promise.all(deferred.splice(0).map((task) => task()));
  };
  /** The streamer is here (a heartbeat) and launches a typed question (1-minute window unless given); the review approves it. */
  const launch = async (windowMin = 1) => {
    await service.beat(STREAMER, COIN, "1.2.3.4");
    await service.act(COIN, STREAMER, { kind: "launch", text: "Will he win this round?", windowMin });
    await settle();
    const view = await service.view(COIN, STREAMER);
    await settle();
    return view.live[0].id;
  };
  /** A view (which runs the clock and any due market steps), with its after-response work done. Signed in: never cached. */
  const look = async () => {
    await service.view(COIN, STREAMER);
    await settle();
    return service.view(COIN, STREAMER);
  };
  /** Test-only points, written straight to the ledger. */
  const fund = (wallet: string, points: number) => store.commit({ docs: [], moves: [{ wallet, delta: points, floor: 0 }], won: [] });
  return { clock, store, service, settle, launch, look, fund };
}

test("markets off: no market, no oracle calls, no registry; the view shows market null", async () => {
  const { calls } = fakeMarkets();
  const { clock, service, launch, look } = setup(null);
  const id = await launch();
  assert.equal((await look()).live[0].market, null);
  clock.t += MIN;
  await service.act(COIN, STREAMER, { kind: "resolve", id, outcome: "yes" });
  clock.t += FLAG_WINDOW_MS;
  const view = await look();
  assert.equal(view.resolved[0].market, null);
  assert.deepEqual(calls, []);
  assert.equal(await service.market(COIN, id), null);
});

test("markets on: create once after review, registered with its lockAt; close at lock; resolve YES after the challenge window", async () => {
  const { calls, deps } = fakeMarkets();
  const { clock, service, launch, look } = setup(deps);
  const id = await launch();
  const opened = await look();
  assert.equal(opened.live[0].market, "open");
  assert.deepEqual(calls, [`create ${id} MIRA`], "created once, with the coin's ticker");
  const record = await service.market(COIN, id);
  assert.equal(record?.question, `question-${id}`);
  assert.equal(record?.lockAt, opened.live[0].lockAt, "the registry knows when betting closes");

  await look();
  assert.equal(calls.length, 1, "nothing more while betting is open");
  clock.t = opened.live[0].lockAt;
  assert.equal((await look()).live[0].market, "closed");
  assert.deepEqual(calls.slice(1), [`close ${id}`]);

  await service.act(COIN, STREAMER, { kind: "resolve", id, outcome: "yes" });
  clock.t += FLAG_WINDOW_MS;
  await look();
  assert.equal(calls.length, 2, "no resolve during the challenge window");
  clock.t += MARKET_CHALLENGE_MS;
  const done = await look();
  assert.equal(done.resolved[0].market, "resolved");
  assert.deepEqual(calls.slice(2), [`resolve ${id} yes`, `redeem ${id}`], "then the oracle redeems its seed");
  clock.t += 10 * MIN;
  await look();
  assert.equal(calls.length, 4, "each step ran once");
});

test("a cancel proposes a refund: on chain after the challenge window; then the oracle redeems its seed, once", async () => {
  const { calls, deps } = fakeMarkets();
  const { clock, service, launch, look } = setup(deps);
  const id = await launch();
  await look();
  clock.t += MIN;
  await look();
  await service.act(COIN, STREAMER, { kind: "resolve", id, outcome: "cancel" });
  clock.t += FLAG_WINDOW_MS;
  await look();
  assert.ok(!calls.some((c) => c.startsWith("resolve")), "a cancel waits out the window like YES or NO");
  clock.t += MARKET_CHALLENGE_MS;
  await look();
  assert.deepEqual(calls.slice(-2), [`resolve ${id} refund`, `redeem ${id}`], "closed and resolved: the oracle redeems");
  clock.t += 10 * MIN;
  await look();
  assert.equal(calls.filter((c) => c.startsWith("redeem")).length, 1);
});

test("a failing create is retried after the short pause, then the market is unavailable and unregistered", async () => {
  const { calls, fail, deps } = fakeMarkets();
  fail.create = 99;
  const { clock, service, launch, look } = setup(deps);
  const id = await launch(5);
  assert.equal((await look()).live[0].market, "opening");
  for (let i = 1; i < MARKET_CREATE_MAX_TRIES; i++) {
    clock.t += MARKET_FAILED_RETRY_MS / 2;
    await look();
    assert.equal(calls.length, i, "not before the pause");
    clock.t += MARKET_FAILED_RETRY_MS / 2;
    await look();
  }
  assert.equal(calls.length, MARKET_CREATE_MAX_TRIES);
  clock.t += MARKET_FAILED_RETRY_MS;
  assert.equal((await look()).live[0].market, "failed");
  assert.equal(await service.market(COIN, id), null, "never registered, so it can't be traded");
});

test("a failing close is retried until it goes through", async () => {
  const { calls, fail, deps } = fakeMarkets();
  const { clock, launch, look } = setup(deps);
  const id = await launch();
  const { lockAt } = (await look()).live[0];
  fail.close = 2;
  clock.t = lockAt;
  for (let i = 0; i < 3; i++) {
    await look();
    clock.t += MARKET_RETRY_MS;
  }
  assert.equal((await look()).live[0].market, "closed");
  assert.deepEqual(calls.filter((c) => c.startsWith("close")), [`close ${id}`, `close ${id}`, `close ${id}`]);
});

test("the streamer and mods count as staff for market bets; viewers don't", async () => {
  const { deps } = fakeMarkets();
  const { service } = setup(deps);
  await service.act(COIN, STREAMER, { kind: "mod", wallet: "mod1", add: true });
  assert.equal(await service.staffOf(COIN, STREAMER), true);
  assert.equal(await service.staffOf(COIN, "mod1"), true);
  assert.equal(await service.staffOf(COIN, "viewer"), false);
});

test("a market whose pool address someone else took is given up on at once, never retried or registered", async () => {
  const { calls, deps } = fakeMarkets();
  const create = deps.create;
  deps.create = async (...args) => {
    await create(...args);
    throw new MarketUnavailable("Someone else made a pool at this market's address");
  };
  const { clock, service, launch, look } = setup(deps);
  const id = await launch(10);
  assert.equal((await look()).live[0].market, "failed");
  clock.t += 5 * MARKET_RETRY_MS;
  await look();
  assert.equal(calls.length, 1);
  assert.equal(await service.market(COIN, id), null);
});

test("a lock that's close gets a timer: trading closes right at lockAt, with no view needed", async () => {
  const { calls, deps } = fakeMarkets();
  const { clock, service, settle, launch, look } = setup(deps, 1_000);
  const id = await launch();
  const { lockAt } = (await look()).live[0];
  clock.t = lockAt - 300;
  setTimeout(() => (clock.t = lockAt), 100); // the clock reaches the lock while the timer waits
  await service.act(COIN, STREAMER, { kind: "crowd", on: false }); // any action starts a market run
  await settle();
  assert.deepEqual(calls, [`create ${id} MIRA`, `close ${id}`], "closed by the timer, not by a later view");
});

/** A market resolved YES by the streamer, with its challenge window open. */
async function proposed() {
  const { calls, deps, holders } = fakeMarkets();
  const env = setup(deps);
  const id = await env.launch();
  await env.look();
  env.clock.t += MIN;
  await env.look();
  await env.service.act(COIN, STREAMER, { kind: "resolve", id, outcome: "yes" });
  return { ...env, calls, holders, id };
}

test("the view shows the proposal, final at the window's end; then final", async () => {
  const { clock, look, id, calls } = await proposed();
  const r = (await look()).resolved[0];
  assert.equal(r.verdict?.status, "proposed");
  assert.equal(r.verdict?.finalAt, r.resolvedAt + MARKET_CHALLENGE_MS);
  clock.t = r.verdict!.finalAt!;
  const done = (await look()).resolved[0];
  assert.deepEqual([done.verdict?.status, done.verdict?.final, done.market], ["final", "yes", "resolved"]);
  assert.deepEqual(calls.slice(-2), [`resolve ${id} yes`, `redeem ${id}`]);
});

test("a holder's challenge takes the bond through the ledger; only admins see the reason; an overturn pays back bond + reward", async () => {
  const { clock, service, look, fund, holders, id, calls } = await proposed();
  await fund("holder", 300);
  await assert.rejects(service.act(COIN, "holder", { kind: "challenge", id, reason: "He clearly lost that round" }), /Only holders/, "no shares yet");
  holders.add("holder");
  const after = await service.act(COIN, "holder", { kind: "challenge", id, reason: "He clearly lost that round", link: "https://clips.example/1" });
  assert.equal(after?.me?.balance, 300 - CHALLENGE_BOND);
  assert.equal(after?.resolved[0].verdict?.status, "disputed");
  assert.equal(after?.resolved[0].verdict?.challenge, null, "the challenger doesn't get the admin view");
  const adminView = await service.view(COIN, ADMIN);
  assert.equal(adminView.me?.admin, true);
  assert.deepEqual(adminView.resolved[0].verdict?.challenge, { by: "holder", at: adminView.resolved[0].verdict!.challenge!.at, reason: "He clearly lost that round", link: "https://clips.example/1", bond: CHALLENGE_BOND });
  clock.t += MARKET_CHALLENGE_MS;
  await look();
  assert.ok(!calls.some((c) => c.startsWith("resolve")), "no resolve while disputed");
  await assert.rejects(service.act(COIN, STREAMER, { kind: "decide", id, outcome: "yes" }), /Only a memestream admin/);
  await service.act(COIN, ADMIN, { kind: "decide", id, outcome: "no" });
  await look();
  assert.deepEqual(calls.slice(-2), [`resolve ${id} no`, `redeem ${id}`]);
  assert.equal((await service.view(COIN, "holder")).me?.balance, 300 + OVERTURN_REWARD);
});

test("the close-due sweep closes trading at lockAt with nobody watching, and drops coins whose markets are done", async () => {
  const { calls, deps } = fakeMarkets();
  const { clock, store, service, launch, look } = setup(deps);
  const id = await launch();
  const { lockAt } = (await look()).live[0];
  const listed = async () => JSON.parse((await store.read(["markets:open"]))[0].json ?? "[]") as string[];
  assert.deepEqual(await listed(), [COIN], "a created market lists its coin");
  clock.t = lockAt;
  assert.deepEqual(await service.sweepMarkets(10), { swept: 1, listed: 1 });
  assert.equal(calls.at(-1), `close ${id}`, "closed by the sweep, no view needed");
  await service.act(COIN, STREAMER, { kind: "resolve", id, outcome: "yes" });
  clock.t += MARKET_CHALLENGE_MS;
  await service.sweepMarkets(10);
  assert.deepEqual(calls.slice(-2), [`resolve ${id} yes`, `redeem ${id}`]);
  assert.deepEqual(await listed(), [], "nothing left to do: the coin leaves the list");
  assert.deepEqual(await service.sweepMarkets(10), { swept: 0, listed: 0 });
});
