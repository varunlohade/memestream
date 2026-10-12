import assert from "node:assert/strict";
import { test } from "node:test";
import { AI_CHECK_RETRY_MS, FLAG_WINDOW_MS } from "@/lib/predictions/rules";
import { newProfile } from "@/lib/predictions/watch";
import { aiCheck, OPENROUTER_URL } from "./ai-check";
import { happenedAnswer, visionAnswer } from "./jev-fake";
import { loadFengari, luaRedis } from "./lua-harness";
import { TYPESAFE_URL } from "./review";
import { type CoinFacts, predictionsService } from "./service";
import { memoryStore, type PredictionStore, redisStore } from "./store";

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T12:00:00.000Z");
const COIN = "coin";
const STREAMER = "streamer";
const TWITCH = "https://twitch.tv/lofigirl";
const BETTORS = ["v1", "v2", "v3", "v4", "v5", "v6"];

const fengari = loadFengari();
type Clock = { t: number };
const STORES: [string, (clock: Clock) => PredictionStore][] = [
  ["memory", (clock) => memoryStore(() => clock.t)],
  ["redis+lua", (clock) => redisStore(luaRedis(fengari, () => clock.t))],
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Fake models behind one fake fetch (no test reaches a real API): the frame CDN, OpenRouter and
 * jev. `happened` is jev's answer; `fail` makes a model call fail; `frame: false` is an offline stream.
 */
function fakeModels() {
  const models = { happened: happenedAnswer("YES") as unknown, fail: false, frame: true, calls: { frame: 0, vision: 0, jev: 0 }, jevBodies: [] as string[] };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://static-cdn.jtvnw.net/")) {
      models.calls.frame++;
      return models.frame ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }) : Promise.reject(new TypeError("redirect"));
    }
    if (u === OPENROUTER_URL) {
      models.calls.vision++;
      return models.fail ? json({}, 500) : json(visionAnswer("A girl with headphones writes at a desk."));
    }
    assert.equal(u, TYPESAFE_URL);
    models.calls.jev++;
    models.jevBodies.push(String(init!.body));
    return models.fail ? json({}, 500) : json(models.happened);
  };
  const ai = aiCheck({ apiKey: "or-test", fetch, sleep: async () => {} }, { apiKey: "ts-test", fetch, sleep: async () => {} }, { fetch });
  return { models, ai };
}

function setup(make: (clock: Clock) => PredictionStore, streamUrl: string | null = TWITCH, withAi = true) {
  const clock = { t: T0 };
  const store = make(clock);
  const { models, ai } = fakeModels();
  const deferred: (() => Promise<void>)[] = [];
  const coins = new Map<string, CoinFacts>([[COIN, { creator: STREAMER, status: "trading", streamUrl }]]);
  const service = predictionsService({
    store,
    now: () => clock.t,
    secret: "test-secret-test-secret-test-secret",
    domain: "memestream.lol",
    coin: async (mint) => coins.get(mint) ?? null,
    holds: async () => true,
    review: async () => ({ approved: true }),
    ai: withAi ? ai : null,
    defer: (task) => void deferred.push(task),
    attempts: 200,
    backoffMs: () => Math.random() * 2,
  });
  const settle = async () => {
    while (deferred.length) await Promise.all(deferred.splice(0).map((task) => task()));
  };
  const fund = async (wallet: string) => {
    const profile = { ...newProfile(), watchMs: 40 * MIN, earningMs: 40 * MIN, starter: true };
    const [doc] = await store.read([`watch:${wallet}`]);
    await store.commit({ docs: [{ key: `watch:${wallet}`, v: doc.v, json: JSON.stringify(profile) }], moves: [{ wallet, delta: 1_000, floor: 0 }], won: [] });
  };
  const balance = async (wallet: string) => (await store.balances([wallet]))[0];
  /** A typed staff question live at T0 (1-minute window), bets on both sides, then betting closes. */
  let liveId = "";
  const playToLock = async () => {
    for (const v of BETTORS) await fund(v);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Is there a person on screen?", windowMin: 1 });
    await settle(); // review approves, the question goes live
    await service.view(COIN, null);
    await settle(); // the launch frame
    liveId = (await service.view(COIN, "v1")).live[0].id;
    for (const [i, v] of BETTORS.entries()) await service.act(COIN, v, { kind: "bet", id: liveId, side: i % 2 ? "yes" : "no", amount: 100 });
    clock.t = T0 + MIN;
    await service.view(COIN, "v1");
    await settle(); // the lock frame
  };
  const resolve = async (outcome: "yes" | "no" | "cancel") => {
    await service.act(COIN, STREAMER, { kind: "resolve", id: liveId, outcome });
    return (await service.view(COIN, "v1")).resolved[0];
  };
  return { clock, service, models, settle, balance, playToLock, resolve, store };
}

for (const [name, make] of STORES) {
  test(`${name}: AI check agrees: frames at launch, lock and resolve; "checking" until it lands; payouts untouched`, async () => {
    const { models, settle, balance, playToLock, resolve, service, clock } = setup(make);
    await playToLock();
    assert.equal(models.calls.vision, 2, "launch and lock frames described");
    const before = await Promise.all(BETTORS.map(balance));
    assert.equal((await resolve("yes")).ai, "checking");
    const paid = await Promise.all(BETTORS.map(balance));
    await settle();
    const r = (await service.view(COIN, "v1")).resolved[0];
    assert.deepEqual([r.ai, r.disputed], ["agree", false]);
    assert.deepEqual(await Promise.all(BETTORS.map(balance)), paid, "the check moves no points");
    assert.notDeepEqual(paid, before, "the resolve itself paid out");
    assert.equal(models.calls.vision, 3);
    const sent = JSON.parse(models.jevBodies[0]);
    assert.deepEqual(sent.state.frames.map((f: { grabbed: string }) => f.grabbed), ["launch", "lock", "resolve"]);
    assert.doesNotMatch(models.jevBodies[0], /"yes"|"no"|outcome/, "jev never sees the streamer's outcome");
    clock.t = T0 + MIN + FLAG_WINDOW_MS;
    assert.equal((await service.view(COIN, "v1")).leaderboard.stream.length, 3, "an agreed result counts");
  });

  test(`${name}: AI check disagrees with good confidence: the result is disputed and off the leaderboard`, async () => {
    const { models, settle, playToLock, resolve, service, clock } = setup(make);
    models.happened = happenedAnswer("YES", 0.9);
    await playToLock();
    await resolve("no");
    await settle();
    let r = (await service.view(COIN, "v1")).resolved[0];
    assert.deepEqual([r.ai, r.disputed], ["disagree", true]);
    clock.t = T0 + MIN + FLAG_WINDOW_MS;
    const view = await service.view(COIN, "v1");
    r = view.resolved[0];
    assert.equal(r.flagUntil, null, "the result closed");
    assert.deepEqual(view.leaderboard.stream, [], "a disputed result counts for no one");
  });

  test(`${name}: AI check unsure (low confidence or UNCLEAR) shows couldn't tell; never disputes`, async () => {
    for (const happened of [happenedAnswer("YES", 0.6), happenedAnswer("UNCLEAR", 0.95)]) {
      const { models, settle, playToLock, resolve, service } = setup(make);
      models.happened = happened;
      await playToLock();
      await resolve("no");
      await settle();
      const r = (await service.view(COIN, "v1")).resolved[0];
      assert.deepEqual([r.ai, r.disputed], ["unclear", false]);
    }
  });

  test(`${name}: a malformed jev answer or failing models never disagree: two retries, then couldn't tell`, async () => {
    for (const broken of ["malformed", "error"] as const) {
      const { models, settle, playToLock, resolve, service, clock } = setup(make);
      await playToLock();
      if (broken === "malformed") models.happened = { answers: { happened: { choice: "YES", probabilities: { YES: 2 }, confidence: 0.99 } } };
      else models.fail = true;
      await resolve("no");
      await settle();
      assert.equal((await service.view(COIN, "v1")).resolved[0].ai, "checking", "a failed run waits for its retry");
      for (let retry = 1; retry <= 2; retry++) {
        clock.t += AI_CHECK_RETRY_MS;
        await service.view(COIN, "v1");
        await settle();
      }
      const r = (await service.view(COIN, "v1")).resolved[0];
      assert.deepEqual([r.ai, r.disputed], ["unclear", false], broken);
      assert.equal(models.calls.jev, broken === "malformed" ? 3 : 0, "three runs in all");
    }
  });

  test(`${name}: no check (no tag) for a cancel, a Kick stream, an offline stream, or no keys`, async () => {
    const cancelled = setup(make);
    await cancelled.playToLock();
    assert.equal((await cancelled.resolve("cancel")).ai, null);

    for (const [streamUrl, withAi] of [["https://kick.com/somebody", true], [TWITCH, false]] as const) {
      const s = setup(make, streamUrl, withAi);
      await s.playToLock();
      assert.equal((await s.resolve("yes")).ai, null);
      await s.settle();
      assert.deepEqual(s.models.calls, { frame: 0, vision: 0, jev: 0 });
    }

    const offline = setup(make);
    offline.models.frame = false;
    await offline.playToLock();
    await offline.resolve("yes");
    await offline.settle();
    const r = (await offline.service.view(COIN, "v1")).resolved[0];
    assert.deepEqual([r.ai, r.disputed, offline.models.calls.vision, offline.models.calls.jev], [null, false, 0, 0]);
  });

  test(`${name}: a check is claimed once: parallel runs ask jev once and commit one verdict`, async () => {
    const { models, settle, playToLock, resolve, service } = setup(make);
    await playToLock();
    await resolve("yes");
    await Promise.all([service.aiRun(COIN, { creator: STREAMER, status: "trading", streamUrl: TWITCH }), settle()]);
    await settle();
    assert.equal(models.calls.jev, 1);
    assert.equal((await service.view(COIN, "v1")).resolved[0].ai, "agree");
  });
}
