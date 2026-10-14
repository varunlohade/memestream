import assert from "node:assert/strict";
import { test } from "node:test";
import { AI_CHECK_RETRY_MS, FLAG_WINDOW_MS, FRAME_GAP_MS, FRAMES_AFTER_LOCK_MS } from "@/lib/predictions/rules";
import { newProfile } from "@/lib/predictions/watch";
import { aiCheck, OPENROUTER_URL } from "./ai-check";
import { happenedAnswer, visionAnswer } from "./jev-fake";
import { loadFengari, luaRedis } from "./lua-harness";
import { TYPESAFE_URL } from "./review";
import { type CoinFacts, predictionsService } from "./service";
import { memoryStore, type PredictionStore, redisStore } from "./store";

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T12:00:00.000Z");
const LOCK = T0 + MIN;
const COIN = "coin";
const STREAMER = "streamer";
/** The memestream oracle: the admin who may always resolve. */
const ORACLE = "oracle";
const TWITCH = "https://twitch.tv/lofigirl";
const BETTORS = ["v1", "v2", "v3", "v4", "v5", "v6"];
const RULE = "YES if a person is seen on screen; NO otherwise.";

const fengari = loadFengari();
type Clock = { t: number };
const STORES: [string, (clock: Clock) => PredictionStore][] = [
  ["memory", (clock) => memoryStore(() => clock.t)],
  ["redis+lua", (clock) => redisStore(luaRedis(fengari, () => clock.t))],
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Fake models behind one fake fetch (no test reaches a real API): the frame CDN, OpenRouter (the
 * check rule and frame descriptions) and jev. `picture` is what the preview shows now (its bytes);
 * `happened` is jev's answer; `fail` makes the model calls fail; `frame: false` is an offline stream.
 */
function fakeModels() {
  const models = {
    happened: happenedAnswer("YES") as unknown,
    fail: false,
    ruleFails: false,
    frame: true,
    picture: 1,
    calls: { frame: 0, rule: 0, vision: 0, jev: 0 },
    jevBodies: [] as string[],
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://static-cdn.jtvnw.net/")) {
      models.calls.frame++;
      return models.frame ? new Response(new Uint8Array([models.picture, 2, 3]), { headers: { "content-type": "image/jpeg" } }) : Promise.reject(new TypeError("redirect"));
    }
    if (u === OPENROUTER_URL) {
      if (String(init!.body).includes("You write the check rule")) {
        models.calls.rule++;
        return models.ruleFails ? json({}, 500) : json(visionAnswer(RULE));
      }
      models.calls.vision++;
      return models.fail ? json({}, 500) : json(visionAnswer(`A girl with headphones writes at a desk (picture ${models.picture}).`));
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
  const coin: CoinFacts = { creator: STREAMER, status: "trading", streamUrl };
  const service = predictionsService({
    store,
    now: () => clock.t,
    secret: "test-secret-test-secret-test-secret",
    domain: "memestream.lol",
    coin: async (mint) => (mint === COIN ? coin : null),
    holds: async () => true,
    review: async () => ({ approved: true, windowMin: 1 }),
    ai: withAi ? ai : null,
    admins: [ORACLE],
    defer: (task) => void deferred.push(task),
    attempts: 200,
    backoffMs: () => Math.random() * 2,
  });
  const settle = async () => {
    while (deferred.length) await Promise.all(deferred.splice(0).map((task) => task()));
  };
  const fund = async (wallet: string) => {
    const profile = { ...newProfile(), granted: true };
    const [doc] = await store.read([`watch:${wallet}`]);
    await store.commit({ docs: [{ key: `watch:${wallet}`, v: doc.v, json: JSON.stringify(profile) }], moves: [{ wallet, delta: 1_000, floor: 0 }], won: [] });
  };
  const balance = async (wallet: string) => (await store.balances([wallet]))[0];
  /** A view at `t` (the clock moves there), with its after-work done. */
  const viewAt = async (t: number, wallet = "v1") => {
    clock.t = t;
    await service.view(COIN, wallet);
    await settle();
    return service.view(COIN, wallet);
  };
  /** A typed staff question live at T0 (1-minute window), its launch frame, bets on both sides. */
  let liveId = "";
  const playToLive = async () => {
    for (const v of BETTORS) await fund(v);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Is there a person on screen?" });
    await settle(); // review approves (and the rule is written); the question goes live
    liveId = (await viewAt(T0)).live[0].id; // the launch frame
    for (const [i, v] of BETTORS.entries()) await service.act(COIN, v, { kind: "bet", id: liveId, side: i % 2 ? "yes" : "no", amount: 100 });
    return liveId;
  };
  return { clock, coin, service, models, settle, balance, viewAt, playToLive, store, id: () => liveId };
}

for (const [name, make] of STORES) {
  test(`${name}: AI first: rule at approval, deduped frames past the lock, then the referee's YES resolves it as "ai"`, async () => {
    const { models, balance, viewAt, playToLive, service, clock } = setup(make);
    await playToLive();
    assert.deepEqual([models.calls.rule, models.calls.vision], [1, 1], "rule written once; launch frame described");
    await viewAt(T0 + FRAME_GAP_MS); // the same picture: fetched, not described
    assert.deepEqual([models.calls.frame, models.calls.vision], [2, 1]);
    const locked = await viewAt(LOCK + FRAME_GAP_MS);
    assert.equal(locked.live[0].ai, "checking", "the same picture after the lock: the referee waits");
    assert.equal(models.calls.jev, 0);
    const before = await Promise.all(BETTORS.map(balance));
    models.picture = 2; // the preview refreshes
    await viewAt(LOCK + 2 * FRAME_GAP_MS); // the new picture is described
    const decided = await viewAt(LOCK + 2 * FRAME_GAP_MS + 1_000); // the referee runs
    assert.deepEqual([models.calls.vision, models.calls.jev], [2, 1]);
    assert.equal(decided.live.length, 0);
    const r = decided.resolved[0];
    assert.deepEqual([r.outcome, r.resolvedBy.role, r.ai], ["yes", "ai", null]);
    assert.match(r.aiReason ?? "", /picture 2/);
    const sent = JSON.parse(models.jevBodies[0]);
    assert.equal(sent.state.check_rule, RULE);
    assert.deepEqual(sent.state.frames.map((f: { grabbed: string }) => f.grabbed), ["launch", "after"]);
    assert.doesNotMatch(models.jevBodies[0], /outcome/);
    const after = await Promise.all(BETTORS.map(balance));
    assert.deepEqual(after.map((b, i) => b - before[i]), [0, 200, 0, 200, 0, 200], "YES bettors are paid");
    clock.t = LOCK + FLAG_WINDOW_MS + 5 * MIN;
    assert.equal((await service.view(COIN, "v1")).leaderboard.stream.length, 3, "the AI's result counts");
  });

  test(`${name}: the referee unsure (low confidence or UNCLEAR): the streamer decides; their call gets the usual check`, async () => {
    for (const happened of [happenedAnswer("YES", 0.6), happenedAnswer("UNCLEAR", 0.95)]) {
      const { models, viewAt, playToLive, service, settle } = setup(make);
      models.happened = happened;
      const id = await playToLive();
      models.picture = 2;
      await viewAt(LOCK);
      const view = await viewAt(LOCK + 1_000);
      assert.equal(view.live[0].ai, "unclear");
      await assert.rejects(service.act(COIN, "v1", { kind: "witness", id, outcome: "yes" }), /streamer or a mod/);
      models.happened = happenedAnswer("NO", 0.9);
      await service.act(COIN, STREAMER, { kind: "witness", id, outcome: "yes" });
      await settle();
      const r = (await service.view(COIN, "v1")).resolved[0];
      assert.deepEqual([r.outcome, r.resolvedBy.role, r.ai, r.disputed], ["yes", "streamer", "disagree", true], "a later frame that says otherwise disputes it");
    }
  });

  test(`${name}: before the referee is done the streamer's answer only informs; an admin may resolve at any time`, async () => {
    const { viewAt, playToLive, service } = setup(make);
    const id = await playToLive();
    assert.equal((await viewAt(LOCK)).live[0].ai, "checking");
    await service.act(COIN, STREAMER, { kind: "witness", id, outcome: "no" });
    const still = await service.view(COIN, "v1");
    assert.deepEqual([still.live.length, still.live[0].witness?.outcome], [1, "no"]);
    await service.act(COIN, ORACLE, { kind: "resolve", id, outcome: "cancel" });
    assert.deepEqual((await service.view(COIN, "v1")).resolved[0].resolvedBy.role, "admin");
  });

  test(`${name}: failing models never pick a side: three referee runs, then the streamer decides`, async () => {
    const { models, viewAt, playToLive } = setup(make);
    await playToLive();
    models.picture = 2;
    await viewAt(LOCK);
    models.fail = true;
    let t = LOCK + 1_000;
    assert.equal((await viewAt(t)).live[0].ai, "checking", "a failed run waits for its retry");
    for (let retry = 1; retry <= 2; retry++) {
      t += AI_CHECK_RETRY_MS;
      await viewAt(t);
    }
    const view = await viewAt(t + 1);
    assert.deepEqual([view.live.length, view.live[0].ai, models.calls.jev], [1, "unclear", 3]);
  });

  test(`${name}: no AI (Kick stream, no keys): no model calls; the streamer decides at the lock`, async () => {
    for (const [streamUrl, withAi] of [["https://kick.com/somebody", true], [TWITCH, false]] as const) {
      const s = setup(make, streamUrl, withAi);
      const id = await s.playToLive();
      assert.equal((await s.viewAt(T0)).live[0].ai, null, "betting open");
      assert.equal((await s.viewAt(LOCK)).live[0].ai, "unclear");
      await s.service.act(COIN, STREAMER, { kind: "witness", id, outcome: "no" });
      await s.settle();
      const r = (await s.service.view(COIN, "v1")).resolved[0];
      assert.deepEqual([r.outcome, r.resolvedBy.role, r.ai], ["no", "streamer", null]);
      assert.deepEqual(s.models.calls, { frame: 0, rule: 0, vision: 0, jev: 0 });
    }
  });

  test(`${name}: an offline stream (no frames): the referee asks no model and hands over 6 minutes after the lock`, async () => {
    const { models, viewAt, playToLive } = setup(make);
    models.frame = false;
    await playToLive();
    assert.equal((await viewAt(LOCK + FRAMES_AFTER_LOCK_MS - 1)).live[0].ai, "checking");
    const view = await viewAt(LOCK + FRAMES_AFTER_LOCK_MS);
    assert.equal((await viewAt(LOCK + FRAMES_AFTER_LOCK_MS + 1)).live[0].ai, "unclear");
    assert.equal(view.live.length, 1);
    assert.deepEqual([models.calls.vision, models.calls.jev], [0, 0]);
  });

  test(`${name}: a failed rule leaves the question without one; the referee still works from the question`, async () => {
    const { models, viewAt, playToLive } = setup(make);
    models.ruleFails = true;
    await playToLive();
    models.picture = 2;
    await viewAt(LOCK);
    await viewAt(LOCK + 1_000);
    assert.equal(JSON.parse(models.jevBodies[0]).state.check_rule, undefined);
  });

  test(`${name}: a referee run is claimed once: parallel runs ask jev once and resolve once`, async () => {
    const { models, viewAt, playToLive, service, settle, coin, clock } = setup(make);
    await playToLive();
    models.picture = 2;
    await viewAt(LOCK);
    clock.t = LOCK + 1_000;
    await Promise.all([service.aiRun(COIN, coin), service.aiRun(COIN, coin), service.view(COIN, "v1").then(settle)]);
    await settle();
    assert.equal(models.calls.jev, 1);
    assert.equal((await service.view(COIN, "v1")).resolved[0].resolvedBy.role, "ai");
  });

  test(`${name}: the live sweep grabs frames and runs the referee with nobody watching`, async () => {
    const { models, service, playToLive, clock, settle } = setup(make);
    await playToLive();
    models.picture = 2;
    clock.t = LOCK;
    assert.deepEqual(await service.sweepLive(10), { swept: 1, listed: 1 });
    clock.t = LOCK + 1_000;
    await service.sweepLive(10);
    await settle();
    assert.equal(models.calls.jev, 1);
    const view = await service.view(COIN, "v1");
    assert.deepEqual([view.live.length, view.resolved[0].resolvedBy.role], [0, "ai"]);
    assert.deepEqual(await service.sweepLive(10), { swept: 0, listed: 0 }, "no live prediction: nothing listed");
  });
}
