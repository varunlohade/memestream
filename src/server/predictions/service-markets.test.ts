import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketRecord } from "@/lib/markets/record";
import { FLAG_WINDOW_MS, MARKET_CREATE_MAX_TRIES, MARKET_RETRY_MS } from "@/lib/predictions/rules";
import { type MarketDeps, predictionsService } from "./service";
import { memoryStore } from "./store";

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T12:00:00.000Z");
const COIN = "coin";
const STREAMER = "streamer";

/** A fake oracle: records every call; `fail` makes the next calls of a kind throw. */
function fakeMarkets() {
  const calls: string[] = [];
  const fail = { create: 0, close: 0, resolve: 0 };
  const deps: MarketDeps = {
    create: async (mint, id, symbol) => {
      calls.push(`create ${id} ${symbol}`);
      if (fail.create-- > 0) throw new Error("devnet said no");
      const record: Omit<MarketRecord, "lockAt"> = {
        mint,
        predictionId: id,
        oracle: "oracle",
        questionId: "00",
        question: `question-${id}`,
        vault: "vault",
        mints: { yes: "yes-mint", no: "no-mint" },
        pools: { yes: "yes-pool", no: "no-pool" },
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
  };
  return { calls, fail, deps };
}

function setup(markets: MarketDeps | null) {
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
  return { clock, store, service, settle, launch, look };
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

test("markets on: create once after review, registered with its lockAt; close at lock; resolve YES after the flag window", async () => {
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
  await look();
  assert.equal(calls.length, 2, "no resolve during the flag window");
  clock.t += FLAG_WINDOW_MS;
  const done = await look();
  assert.equal(done.resolved[0].market, "resolved");
  assert.deepEqual(calls.slice(2), [`resolve ${id} yes`]);
  clock.t += 10 * MIN;
  await look();
  assert.equal(calls.length, 3, "each step ran once");
});

test("a cancelled prediction's market resolves as a refund", async () => {
  const { calls, deps } = fakeMarkets();
  const { clock, service, launch, look } = setup(deps);
  const id = await launch();
  await look();
  clock.t += MIN;
  await look();
  await service.act(COIN, STREAMER, { kind: "resolve", id, outcome: "cancel" });
  clock.t += FLAG_WINDOW_MS;
  await look();
  assert.equal(calls.at(-1), `resolve ${id} refund`);
});

test("a failing create is retried after the pause, then the market is unavailable and unregistered", async () => {
  const { calls, fail, deps } = fakeMarkets();
  fail.create = 99;
  const { clock, service, launch, look } = setup(deps);
  const id = await launch(5);
  assert.equal((await look()).live[0].market, "opening");
  for (let i = 1; i < MARKET_CREATE_MAX_TRIES; i++) {
    clock.t += MARKET_RETRY_MS / 2;
    await look();
    assert.equal(calls.length, i, "not before the pause");
    clock.t += MARKET_RETRY_MS / 2;
    await look();
  }
  assert.equal(calls.length, MARKET_CREATE_MAX_TRIES);
  clock.t += MARKET_RETRY_MS;
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
