import assert from "node:assert/strict";
import { test } from "node:test";
import { AI_CHECK_RETRY_MS, FLAG_WINDOW_MS, REVIEW_RETRY_MS, FRAME_GAP_MS, FRAMES_AFTER_LOCK_MS } from "@/lib/predictions/rules";
import { newProfile } from "@/lib/predictions/watch";
import { aiCheck, OPENROUTER_URL } from "./ai-check";
import { CLIP_LAG_MS, clipClient } from "./clip";
import { factsAnswer, happenedAnswer, visionAnswer } from "./jev-fake";
import { loadFengari, luaRedis } from "./lua-harness";
import { REVIEW_PAUSED_TEXT } from "@/lib/predictions/engine";
import { ReviewBudgetSpent, TYPESAFE_URL } from "./review";
import { liveSlotKeys } from "./game-doc";
import { type CoinFacts, LOCK_CLIPS, lockClipDue, marketFacts, predictionsService, type ServiceDeps, urgentFirst } from "./service";
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
 * `withClip`: a video grabber too (`clipFails`: it answers 502), whose clips have audio.
 */
const GRABBER = "https://grabber.test/clip";
function fakeModels(withClip = false, now: () => number = Date.now) {
  const models = {
    happened: happenedAnswer("YES") as unknown,
    fail: false,
    ruleFails: false,
    frame: true,
    picture: 1,
    /** The CDN's Last-Modified for the picture (ms), if it sends one. */
    shot: undefined as number | undefined,
    clipFails: false,
    calls: { frame: 0, rule: 0, vision: 0, jev: 0, clip: 0 },
    visionBodies: [] as string[],
    jevBodies: [] as string[],
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://static-cdn.jtvnw.net/")) {
      models.calls.frame++;
      const headers = { "content-type": "image/jpeg", ...(models.shot !== undefined ? { "last-modified": new Date(models.shot).toUTCString() } : {}) };
      return models.frame ? new Response(new Uint8Array([models.picture, 2, 3]), { headers }) : Promise.reject(new TypeError("redirect"));
    }
    if (u === GRABBER) {
      models.calls.clip++;
      const frame = { mime: "image/jpeg", base64: Buffer.from([9, models.picture, models.calls.clip]).toString("base64") };
      return models.clipFails ? json({ error: "stream not live" }, 502) : json({ frames: [frame, frame], audio: { format: "mp3", base64: "AAAA" }, startedAt: now(), endedAt: now() });
    }
    if (u === OPENROUTER_URL) {
      if (String(init!.body).includes("You write the check rule")) {
        models.calls.rule++;
        return models.ruleFails ? json({}, 500) : json(visionAnswer(RULE));
      }
      models.calls.vision++;
      models.visionBodies.push(String(init!.body));
      if (String(init!.body).includes('"input_audio"')) return models.fail ? json({}, 500) : json(factsAnswer(["A girl says hello to chat (clip)", "audio"], ["A girl at a desk (clip)", "camera"]));
      return models.fail ? json({}, 500) : json(factsAnswer([`A girl with headphones writes at a desk (picture ${models.picture})`, "camera"]));
    }
    assert.equal(u, TYPESAFE_URL);
    models.calls.jev++;
    models.jevBodies.push(String(init!.body));
    return models.fail ? json({}, 500) : json(models.happened);
  };
  const clip = withClip ? clipClient({ url: GRABBER, secret: "g".repeat(32), fetch }) : null;
  const ai = aiCheck({ apiKey: "or-test", fetch, sleep: async () => {} }, { apiKey: "ts-test", fetch, sleep: async () => {} }, { fetch }, clip, now);
  return { models, ai };
}

function setup(make: (clock: Clock) => PredictionStore, streamUrl: string | null = TWITCH, withAi = true, aiBudget?: ServiceDeps["aiBudget"], withClip = false) {
  const clock = { t: T0 };
  const store = make(clock);
  const { models, ai } = fakeModels(withClip, () => clock.t);
  const deferred: (() => Promise<void>)[] = [];
  /** The next this many question reviews fail. */
  let reviewFailures = 0;
  const coin: CoinFacts = { creator: STREAMER, status: "trading", streamUrl };
  const service = predictionsService({
    store,
    now: () => clock.t,
    secret: "test-secret-test-secret-test-secret",
    domain: "memestream.lol",
    coin: async (mint) => (mint === COIN ? coin : null),
    holds: async () => true,
    // The review takes its call from the budget, as the real client does before every attempt.
    review: async (_question, spend) => {
      if (!(await spend())) throw new ReviewBudgetSpent("The daily AI budget is used up");
      if (reviewFailures > 0 && reviewFailures--) throw new Error("jev is down");
      return { approved: true, windowMin: 1 };
    },
    ai: withAi ? ai : null,
    admins: [ORACLE],
    ...(aiBudget ? { aiBudget } : {}),
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
  const failReviews = (n: number) => void (reviewFailures = n);
  return { clock, coin, service, models, settle, balance, viewAt, playToLive, store, failReviews, id: () => liveId };
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
    assert.equal(sent.state.check_rule_hint, RULE);
    assert.equal(locked.live[0].rule, RULE, "bettors see the rule under the question");
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
      assert.equal((await viewAt(LOCK + 1_000)).live[0].ai, "checking", "unsure early: one more run at the window's end");
      const view = await viewAt(LOCK + FRAMES_AFTER_LOCK_MS + 1_000);
      assert.equal(view.live[0].ai, "unclear");
      assert.deepEqual([models.calls.jev, view.live[0].aiWhy, (await service.view(COIN, ORACLE)).live[0].aiWhy], [2, null, "unclear"], "only admins see why");
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
      assert.deepEqual(s.models.calls, { frame: 0, rule: 0, vision: 0, jev: 0, clip: 0 });
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

  test(`${name}: the preview never refreshed after the lock: no YES or NO from old pictures, the streamer decides at 6 minutes`, async () => {
    const { models, viewAt, playToLive } = setup(make);
    await playToLive();
    await viewAt(LOCK + FRAMES_AFTER_LOCK_MS);
    const view = await viewAt(LOCK + FRAMES_AFTER_LOCK_MS + 1);
    assert.deepEqual([view.live.length, view.live[0].ai, models.calls.jev, models.calls.vision], [1, "unclear", 0, 1]);
  });

  test(`${name}: audit F2: a picture the CDN made before the lock is not evidence; admins see "no picture after lock"`, async () => {
    const { models, viewAt, playToLive, service } = setup(make);
    await playToLive();
    models.picture = 2;
    models.shot = LOCK - 2 * MIN; // new to us, but made before betting closed
    await viewAt(LOCK + 30_000);
    assert.equal(models.calls.vision, 2, "described, but not fresh");
    assert.equal((await viewAt(LOCK + MIN)).live[0].ai, "checking");
    await viewAt(LOCK + FRAMES_AFTER_LOCK_MS);
    const view = await service.view(COIN, ORACLE);
    assert.deepEqual([view.live[0].ai, view.live[0].aiWhy, models.calls.jev], ["unclear", "no-picture", 0]);
  });

  test(`${name}: audit F5: the daily AI budget stops model calls (here: the review and the rule take the only two)`, async () => {
    const { models, viewAt, playToLive, store } = setup(make, TWITCH, true, { daily: 100, perCoin: 2 });
    await playToLive();
    models.picture = 2;
    await viewAt(LOCK);
    await viewAt(LOCK + FRAMES_AFTER_LOCK_MS);
    const view = await viewAt(LOCK + FRAMES_AFTER_LOCK_MS + 1);
    assert.deepEqual([models.calls.rule, models.calls.vision, models.calls.jev], [1, 0, 0]);
    assert.equal(view.live[0].ai, "unclear");
    const day = new Date(T0).toISOString().slice(0, 10);
    const keys = [`ai-calls:${day}`, `ai-calls:${day}:${COIN}`];
    assert.equal(await store.take(keys, [100, 2], MIN), false, "the coin's counter is at 2 of 2");
    assert.equal(await store.take(keys, [3, 3], MIN), true, "both counters were at exactly 2");
  });

  test(`${name}: audit 6: question reviews take from the budget too; spent, the question waits for the streamer, who is told why`, async () => {
    const { service, settle } = setup(make, TWITCH, true, { daily: 100, perCoin: 0 });
    await service.act(COIN, STREAMER, { kind: "launch", text: "Is there a person on screen?" });
    await service.view(COIN, STREAMER);
    await settle();
    const view = await service.view(COIN, STREAMER);
    assert.deepEqual([view.live.length, view.pending?.stuck, view.me?.notice], [0, true, REVIEW_PAUSED_TEXT], "not live; stuck for a hand decision");
    await service.act(COIN, STREAMER, { kind: "approve", id: view.pending!.id });
    assert.equal((await service.view(COIN, STREAMER)).live.length, 1, "the streamer approves it by hand");
  });

  test(`${name}: audit N3: the budget counter is atomic: parallel takes never conflict and never pass the limit`, async () => {
    const { store } = setup(make);
    const taken = await Promise.all(Array.from({ length: 20 }, () => store.take(["c:global", "c:coin"], [100, 7], MIN)));
    assert.equal(taken.filter(Boolean).length, 7);
  });

  test(`${name}: audit N3: one picture is described once for all the coin's live predictions, and saved to each`, async () => {
    const { models, viewAt, playToLive, service, settle, store } = setup(make);
    await playToLive();
    await service.act(COIN, STREAMER, { kind: "launch", text: "Is it raining outside?" });
    await settle();
    await viewAt(T0 + 1_000); // the second goes live; its first grab
    models.picture = 2;
    const before = models.calls.vision;
    await viewAt(T0 + 2 * FRAME_GAP_MS);
    assert.equal(models.calls.vision, before + 1, "one description for both");
    const slots = (await store.read(liveSlotKeys(COIN))).flatMap((d) => (d.json ? [JSON.parse(d.json)] : []));
    assert.equal(slots.length, 2);
    for (const p of slots) assert.ok(p.frames.some((f: { text: string }) => f.text.includes("picture 2")), `prediction ${p.id} has the shared note`);
  });

  test(`${name}: audit 5: a store from before the work index is backfilled once (live and market coins); idle ones are dropped`, async () => {
    const { models, service, playToLive, clock, store } = setup(make);
    await playToLive();
    // As main left it: no work index, no marker; a coin listed for markets with nothing to do here.
    const unlist = { docs: [], sets: [{ key: "predictions:work", member: COIN, add: false }], moves: [], won: [] };
    await store.commit(unlist);
    const [open] = await store.read(["markets:open"]);
    await store.commit({ docs: [{ key: "markets:open", v: open.v, json: JSON.stringify(["ghost"]) }], moves: [], won: [] });
    assert.deepEqual(await store.members("predictions:work"), []);
    models.picture = 2;
    clock.t = LOCK;
    assert.deepEqual(await service.sweepLive(10), { swept: 2, listed: 2 }, "both backfilled and swept");
    assert.equal(models.calls.vision, 2, "the live prediction got its frame with nobody watching");
    assert.deepEqual(await store.members("predictions:work"), [COIN], "the unknown coin is dropped, the live one kept");
    await store.commit(unlist);
    assert.deepEqual(await service.sweepLive(10), { swept: 0, listed: 0 }, "once only: the marker stops a second backfill");
  });

  test(`${name}: audit 3-7: a question whose first review failed is retried by the sweep, with nobody watching`, async () => {
    const { service, settle, failReviews, clock, store } = setup(make);
    failReviews(1);
    await service.act(COIN, STREAMER, { kind: "launch", text: "Is there a person on screen?" });
    await settle(); // the first review fails; nobody opens the coin after this
    assert.deepEqual(await store.members("predictions:work"), [COIN], "a question under review is work");
    clock.t += REVIEW_RETRY_MS;
    await service.sweepLive(10);
    const [doc] = await store.read([`coin:${COIN}`]);
    assert.equal(JSON.parse(doc.json!).live.length, 1, "approved and live, by the sweep alone");
  });

  test(`${name}: audit 6: the sweep keeps visiting a coin with no live prediction while a check is due, then drops it`, async () => {
    const { models, viewAt, playToLive, service, clock } = setup(make);
    models.happened = happenedAnswer("UNCLEAR", 0.95);
    const id = await playToLive();
    models.picture = 2;
    await viewAt(LOCK);
    await viewAt(LOCK + FRAMES_AFTER_LOCK_MS + 1_000);
    await service.act(COIN, STREAMER, { kind: "witness", id, outcome: "yes" }); // a check is due; nobody watches
    models.happened = happenedAnswer("NO", 0.9);
    const jevBefore = models.calls.jev;
    assert.deepEqual(await service.sweepLive(10), { swept: 1, listed: 1 }, "listed with no live prediction");
    assert.equal(models.calls.jev, jevBefore + 1, "the sweep ran the check");
    clock.t = LOCK + FRAMES_AFTER_LOCK_MS + FLAG_WINDOW_MS + 2_000;
    await service.sweepLive(10); // the flag window closes: the result counts
    assert.deepEqual(await service.sweepLive(10), { swept: 0, listed: 0 }, "nothing left to do: dropped");
    assert.equal((await service.view(COIN, "v1")).resolved[0].ai, "disagree");
  });

  test(`${name}: a failed rule leaves the question without one; the referee still works from the question`, async () => {
    const { models, viewAt, playToLive } = setup(make);
    models.ruleFails = true;
    await playToLive();
    models.picture = 2;
    await viewAt(LOCK);
    await viewAt(LOCK + 1_000);
    assert.equal(JSON.parse(models.jevBodies[0]).state.check_rule_hint, undefined);
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

  test(`${name}: with the video grabber, a clip (frames and audio) is the evidence after the lock and at resolve; launch keeps the preview`, async () => {
    const { models, viewAt, playToLive } = setup(make, TWITCH, true, undefined, true);
    await playToLive();
    assert.deepEqual([models.calls.clip, models.calls.frame, models.calls.vision], [0, 1, 1], "the launch grab uses the preview");
    await viewAt(T0 + FRAME_GAP_MS);
    assert.equal(models.calls.clip, 0, "live grabs use the preview");
    await viewAt(LOCK + FRAME_GAP_MS);
    assert.deepEqual([models.calls.clip, models.calls.frame], [0, 3], "within CLIP_LAG_MS of the lock a clip may hold pre-lock footage: the preview");
    await viewAt(LOCK + 2 * FRAME_GAP_MS);
    assert.deepEqual([models.calls.clip, models.calls.vision], [1, 2], "past it, a clip, described in one call");
    assert.match(models.visionBodies.at(-1)!, /"type":"input_audio","input_audio":\{"data":"AAAA","format":"mp3"\}/);
    const decided = await viewAt(LOCK + 2 * FRAME_GAP_MS + 1_000);
    const r = decided.resolved[0];
    assert.deepEqual([r.outcome, r.resolvedBy.role], ["yes", "ai"]);
    assert.match(r.aiReason ?? "", /\[audio\] A girl says hello to chat \(clip\)/, "audio facts count for points");
    const sent = JSON.parse(models.jevBodies[0]).state.frames.at(-1);
    assert.deepEqual([sent.grabbed, sent.taken], ["after", new Date(LOCK + 2 * FRAME_GAP_MS - CLIP_LAG_MS).toISOString()], "a clip's time is its earliest possible footage");
  });

  test(`${name}: clips only for the first ${LOCK_CLIPS} pictures after the lock; later grabs use the preview`, async () => {
    const { models, viewAt, playToLive } = setup(make, TWITCH, true, undefined, true);
    models.happened = happenedAnswer("UNCLEAR", 0.95); // the referee waits, so grabbing goes on
    await playToLive();
    // One grab inside CLIP_LAG_MS of the lock (a preview, which takes no clip slot), then every FRAME_GAP_MS from the clip window on.
    for (const t of [LOCK + 10_000, ...[0, 1, 2, 3, 4].map((i) => LOCK + CLIP_LAG_MS + i * FRAME_GAP_MS)]) {
      models.picture++; // a new preview each time, so each grab is described
      await viewAt(t);
    }
    assert.equal(models.calls.clip, LOCK_CLIPS);
    const described = models.visionBodies.slice(1).map((body) => (body.includes("input_audio") ? "clip" : "preview"));
    assert.deepEqual(described.slice(0, 1 + LOCK_CLIPS), ["preview", "clip", "clip"]);
    assert.ok(described.length > 1 + LOCK_CLIPS && described.slice(1 + LOCK_CLIPS).every((d) => d === "preview"), described.join(", "));
  });

  test(`${name}: a failing grabber falls back to the preview after the lock; at resolve the check uses a clip`, async () => {
    const { models, viewAt, playToLive, service, settle } = setup(make, TWITCH, true, undefined, true);
    models.happened = happenedAnswer("UNCLEAR", 0.95);
    const id = await playToLive();
    models.clipFails = true;
    models.picture = 2;
    await viewAt(LOCK + CLIP_LAG_MS);
    assert.deepEqual([models.calls.clip, models.calls.frame], [1, 2], "the clip failed: the preview was grabbed");
    assert.doesNotMatch(models.visionBodies.at(-1)!, /input_audio/);
    models.picture = 3;
    await viewAt(LOCK + CLIP_LAG_MS + FRAME_GAP_MS); // the referee's early run (the preview was fresh)
    await viewAt(LOCK + CLIP_LAG_MS + 2 * FRAME_GAP_MS); // still inside CLIP_PAUSE_MS of the failure
    assert.deepEqual([models.calls.clip, models.calls.frame], [1, 3], "after a failure the next grab uses the preview, without asking the grabber");
    assert.equal((await viewAt(LOCK + FRAMES_AFTER_LOCK_MS + 1_000)).live[0].ai, "unclear");
    models.clipFails = false;
    const clips = models.calls.clip;
    models.happened = happenedAnswer("NO", 0.9);
    await service.act(COIN, STREAMER, { kind: "witness", id, outcome: "yes" });
    await settle();
    assert.equal(models.calls.clip, clips + 1, "the check at resolve grabbed a clip");
    assert.match(models.visionBodies.at(-1)!, /input_audio/);
    assert.equal(JSON.parse(models.jevBodies.at(-1)!).state.frames.at(-1).grabbed, "resolve");
    assert.deepEqual((await service.view(COIN, "v1")).resolved[0].ai, "disagree");
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
    assert.deepEqual(await service.sweepLive(10), { swept: 1, listed: 1 }, "still listed while its flag window is open");
    clock.t = LOCK + 1_000 + FLAG_WINDOW_MS;
    await service.sweepLive(10);
    assert.deepEqual(await service.sweepLive(10), { swept: 0, listed: 0 }, "its result counted: nothing left, dropped");
  });
}

test("audit N2: the sweep takes coins inside an evidence window first", () => {
  const doc = (lockAt: number) => JSON.stringify({ live: [{ id: "1", slot: 0, text: "Q", lockAt }] });
  const order = urgentFirst(["open", "done", "locked", "none"], [doc(T0 + MIN), doc(T0 - 60 * MIN), doc(T0 - MIN), null], T0);
  assert.deepEqual(order, ["locked", "open", "done", "none"]);
});

test("audit F3: a market decides on game-screen and camera facts only (unknown and audio sources dropped too)", () => {
  const note = { kind: "after" as const, at: T0, text: "[game_ui] Score 13-11; [unknown] A banner says WIN; [camera] A man jumps" };
  assert.equal(marketFacts(note).text, "[game_ui] Score 13-11; [camera] A man jumps");
  assert.match(marketFacts({ ...note, text: "[unknown] WIN" }).text!, /^Nothing on the game screen/);
  assert.equal(marketFacts({ ...note, text: "[audio] The streamer says he won; [camera] A man jumps" }).text, "[camera] A man jumps", "anyone can say anything into the mic");
});

test("lockClipDue: a clip only once the lock is CLIP_LAG_MS behind (so it is fresh), for the first LOCK_CLIPS pictures from then on", () => {
  const base = { id: "1", text: "Q?", rule: null, kind: "after" as const, lockAt: LOCK, hashes: [] };
  const note = (at: number) => ({ kind: "after" as const, at, text: "x" });
  assert.equal(lockClipDue({ ...base, at: LOCK + CLIP_LAG_MS - 1, frames: [] }), false, "too soon: the preview");
  assert.equal(lockClipDue({ ...base, at: LOCK + CLIP_LAG_MS, frames: [note(LOCK + 10_000)] }), true, "a preview grabbed earlier takes no clip slot");
  assert.equal(lockClipDue({ ...base, at: LOCK + 3 * MIN, frames: [note(LOCK + CLIP_LAG_MS)] }), true, "one clip so far");
  assert.equal(lockClipDue({ ...base, at: LOCK + 3 * MIN, frames: [note(LOCK + CLIP_LAG_MS), note(LOCK + 2 * MIN)] }), false, "two: later grabs use the preview");
  assert.equal(lockClipDue({ ...base, kind: "live", at: LOCK + 3 * MIN, frames: [] }), false, "betting still open");
});
