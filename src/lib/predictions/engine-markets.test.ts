import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, apply, applyAiVerdict, applyMarketDone, applyReview, type Env, type Game, marketsDue, newGame, type Result, startMarkets } from "./engine";
import { CHALLENGE_BOND, FLAG_WINDOW_MS, MARKET_CHALLENGE_MS, MARKET_CREATE_MAX_TRIES, MARKET_DECISION_MS, MARKET_RETRY_MS, MAX_HISTORY, OVERTURN_REWARD } from "./rules";

const MIN = 60_000;
const T0 = 1_000_000_000;
const STREAMER = "Streamer";
const ADMIN = "Admin";
const HOLDER = "Holder";
const QUESTION = "Q".repeat(44);
const viewer = (wallet: string): Actor => ({ wallet, eligible: true, holder: true, balance: 1_000 });
const streamer: Actor = { wallet: STREAMER, eligible: true, holder: false, balance: 0 };
const admin: Actor = { wallet: ADMIN, eligible: true, holder: false, balance: 0 };
const holder = (balance = 500, shares = true): Actor => ({ wallet: HOLDER, eligible: true, holder: true, balance, shares });
const on = (now: number, extra: Partial<Env> = {}): Env => ({ streamerSeenAt: now - MIN, markets: true, admins: [ADMIN], ...extra });
const off = (now: number): Env => ({ streamerSeenAt: now - MIN });
/** The net points change for `wallet` in a result. */
const delta = (r: Result, wallet: string) => r.moves.get(wallet)?.delta ?? 0;

/** The streamer launches a typed question (1-minute window unless given); the review approves it at T0. */
function launched(env: (now: number) => Env = on, windowMin = 1): Game {
  const typed = apply(newGame(STREAMER), { kind: "launch", text: "Will he win this round?", windowMin }, streamer, T0, env(T0)).game;
  return applyReview(typed, typed.pending!, { approved: true }, T0, env(T0)).game;
}

const claim = (game: Game, now: number, env = on(now)) => startMarkets(game, now, env);
const LOCK = T0 + MIN;
const RESOLVED_AT = LOCK;
const WINDOW_END = RESOLVED_AT + MARKET_CHALLENGE_MS;

/** A market that opened, then (unless `close` is false) closed at lock, then the streamer resolved it with `outcome`. */
function resolvedWith(outcome: "yes" | "no" | "cancel", { close = true, env = on }: { close?: boolean; env?: (now: number) => Env } = {}) {
  let game = launched(env);
  const id = game.live[0].id;
  game = applyMarketDone(game, { id, kind: "create" }, QUESTION, T0, env(T0)).game;
  game = apply(game, { kind: "bet", id, side: "no", amount: 10 }, viewer("v1"), T0 + 1_000, env(T0)).game;
  if (close) game = applyMarketDone(game, { id, kind: "close" }, null, LOCK, env(LOCK)).game;
  game = apply(game, { kind: "resolve", id, outcome }, streamer, RESOLVED_AT, env(RESOLVED_AT)).game;
  return { game, id };
}
const resolveJob = (game: Game, now: number, env = on(now)) => claim(game, now, env).jobs.find((j) => j.kind === "resolve");

test("markets off: a prediction goes live with no market, and no market step is ever due", () => {
  const game = launched(off);
  assert.equal(game.live[0].market, undefined);
  assert.equal(marketsDue(game, T0, off(T0)), false);
  const resolved = apply(game, { kind: "resolve", id: game.live[0].id, outcome: "yes" }, streamer, LOCK, off(LOCK)).game;
  assert.equal(resolved.resolved[0].market, undefined);
  assert.equal(marketsDue(resolved, WINDOW_END, off(T0)), false);
  assert.deepEqual(claim(resolved, WINDOW_END, off(T0)).jobs, []);
});

test("markets on: a prediction that goes live after its review is opening, and its create is claimed once", () => {
  const game = launched();
  const id = game.live[0].id;
  assert.deepEqual(game.live[0].market, { step: "opening", tries: 0, at: T0 });
  const first = claim(game, T0);
  assert.deepEqual(first.jobs, [{ id, kind: "create" }]);
  assert.deepEqual(first.game.live[0].market, { step: "opening", tries: 1, at: T0 });
  assert.deepEqual(claim(first.game, T0 + 1_000).jobs, [], "a claimed create isn't started again before its retry pause");
});

test("full life: create, close at lock, resolve YES only after the challenge window", () => {
  let game = claim(launched(), T0).game;
  const id = game.live[0].id;
  game = applyMarketDone(game, { id, kind: "create" }, QUESTION, T0 + 5_000, on(T0)).game;
  assert.deepEqual(game.live[0].market, { step: "open", tries: 0, at: T0 + 5_000, question: QUESTION });
  assert.deepEqual(claim(game, T0 + 30_000).jobs, [], "nothing to do while betting is open");
  const close = claim(game, LOCK);
  assert.deepEqual(close.jobs, [{ id, kind: "close" }]);
  game = applyMarketDone(close.game, { id, kind: "close" }, null, LOCK + 1_000, on(LOCK)).game;
  assert.equal(game.live[0].market?.closed, true);
  game = apply(game, { kind: "resolve", id, outcome: "yes" }, streamer, LOCK + 2_000, on(LOCK)).game;
  assert.equal(game.resolved[0].market?.closed, true, "the market moves with the result");
  assert.deepEqual(claim(game, LOCK + 2_000 + FLAG_WINDOW_MS).jobs, [], "the points flag window doesn't matter");
  const end = LOCK + 2_000 + MARKET_CHALLENGE_MS;
  const resolve = claim(game, end);
  assert.deepEqual(resolve.jobs, [{ id, kind: "resolve", outcome: "yes" }]);
  game = applyMarketDone(resolve.game, resolve.jobs[0], null, end + 1_000, on(end)).game;
  assert.deepEqual(game.resolved[0].market, { step: "resolved", closed: true, tries: 0, at: end + 1_000, question: QUESTION });
  assert.equal(marketsDue(game, end + 10 * MIN, on(end)), false);
});

test("audit H1: a close that keeps failing never holds up the resolution; the close is still retried after", () => {
  const { game, id } = resolvedWith("yes", { close: false });
  assert.deepEqual(claim(game, WINDOW_END).jobs, [
    { id, kind: "close" },
    { id, kind: "resolve", outcome: "yes" },
  ]);
  const resolved = applyMarketDone(claim(game, WINDOW_END).game, { id, kind: "resolve", outcome: "yes" }, null, WINDOW_END, on(WINDOW_END)).game;
  assert.equal(resolved.resolved[0].market?.step, "resolved");
  assert.deepEqual(claim(resolved, WINDOW_END + MARKET_RETRY_MS).jobs, [{ id, kind: "close" }], "the close keeps going: it gets the seed back");
});

test("idempotent: a step that succeeds twice, or for the wrong step, changes nothing", () => {
  let game = claim(launched(), T0).game;
  const id = game.live[0].id;
  game = applyMarketDone(game, { id, kind: "create" }, QUESTION, T0 + 1_000, on(T0)).game;
  assert.equal(applyMarketDone(game, { id, kind: "create" }, "other", T0 + 2_000, on(T0)).changed, false);
  game = applyMarketDone(game, { id, kind: "close" }, null, T0 + 2_000, on(T0)).game;
  assert.equal(applyMarketDone(game, { id, kind: "close" }, null, T0 + 3_000, on(T0)).changed, false);
  assert.equal(applyMarketDone(game, { id: "999", kind: "close" }, null, T0 + 2_000, on(T0)).changed, false);
});

test("audit M1: a challenge filed before a late close survives the close and the resolve", () => {
  const { game, id } = resolvedWith("yes", { close: false });
  const r = apply(game, { kind: "challenge", id, reason: "the stream showed NO" }, holder(), RESOLVED_AT + MIN, on(RESOLVED_AT));
  const closed = applyMarketDone(r.game, { id, kind: "close" }, null, RESOLVED_AT + 2 * MIN, on(RESOLVED_AT)).game;
  assert.ok(closed.resolved[0].market?.challenge, "the close kept the challenge");
  assert.equal(resolveJob(closed, WINDOW_END), undefined, "still waiting for an admin");
  const decided = apply(closed, { kind: "decide", id, outcome: "no" }, admin, WINDOW_END, on(WINDOW_END)).game;
  const done = applyMarketDone(decided, { id, kind: "resolve", outcome: "no" }, null, WINDOW_END, on(WINDOW_END)).game;
  assert.deepEqual(done.resolved[0].market?.decision, { outcome: "no", by: ADMIN, at: WINDOW_END }, "the resolve kept the decision");
  assert.equal(done.resolved[0].market?.challenge?.by, HOLDER);
});

test("a failed create is tried again after the pause, up to the limit, then the market is unavailable", () => {
  let game = launched(on, 10);
  let now = T0;
  for (let i = 0; i < MARKET_CREATE_MAX_TRIES; i++) {
    const c = claim(game, now);
    assert.equal(c.jobs.length, 1, `try ${i + 1}`);
    game = c.game;
    now += MARKET_RETRY_MS - 1;
    assert.deepEqual(claim(game, now).jobs, [], "not before the pause");
    now += 1;
  }
  assert.equal(apply(game, { kind: "tick" }, null, now, on(now)).game.live[0].market?.step, "failed");
});

test("a market still opening when betting closes is given up on; a create that lands later still opens it", () => {
  const game = launched();
  const id = game.live[0].id;
  const failed = apply(game, { kind: "tick" }, null, LOCK, on(LOCK)).game;
  assert.equal(failed.live[0].market?.step, "failed");
  assert.deepEqual(claim(failed, LOCK).jobs, []);
  const late = applyMarketDone(failed, { id, kind: "create" }, QUESTION, LOCK + 1_000, on(LOCK)).game;
  assert.equal(late.live[0].market?.step, "open");
  assert.deepEqual(claim(late, LOCK + 1_000).jobs, [{ id, kind: "close" }], "so its seed comes back");
});

test("a result whose market isn't done yet stays in the history past MAX_HISTORY", () => {
  const { game } = resolvedWith("yes");
  const old = game.resolved[0];
  const filler = Array.from({ length: MAX_HISTORY + 2 }, (_, i) => ({ ...old, id: String(500 + i), market: undefined, open: null }));
  const after = apply({ ...game, resolved: [...filler, old] }, { kind: "tick" }, null, LOCK + FLAG_WINDOW_MS, on(T0)).game;
  assert.equal(after.resolved.length, MAX_HISTORY + 1);
  assert.equal(after.resolved.at(-1)?.id, old.id);
});

// ---- Proposals, the challenge window, and admins ----

test("the streamer's YES, NO or cancel is only a proposal: final at the window's end; free-points flags change nothing", () => {
  for (const outcome of ["yes", "no", "cancel"] as const) {
    const { game, id } = resolvedWith(outcome);
    assert.equal(resolveJob(game, WINDOW_END - 1), undefined, `${outcome}: not before the window ends`);
    assert.deepEqual(resolveJob(game, WINDOW_END), { id, kind: "resolve", outcome: outcome === "cancel" ? "refund" : outcome });
  }
  const { game, id } = resolvedWith("yes");
  const flagged = apply(game, { kind: "flag", id }, viewer("v1"), RESOLVED_AT + 1_000, on(T0)).game;
  assert.equal(flagged.resolved[0].disputed, true, "disputed for the points game");
  assert.deepEqual(resolveJob(flagged, WINDOW_END), { id, kind: "resolve", outcome: "yes" }, "free-points flags can't force a real-SOL refund");
});

test("a test window from the env: shorter windows end sooner", () => {
  const { game, id } = resolvedWith("yes");
  assert.deepEqual(resolveJob(game, RESOLVED_AT + 3 * MIN, on(RESOLVED_AT, { challengeMs: 3 * MIN })), { id, kind: "resolve", outcome: "yes" });
});

test("audit H2: resolve waits for the AI check; an AI disagree alone sends it to an admin, it never refunds by itself", () => {
  const short = (now: number) => on(now, { aiCheck: true, challengeMs: 3 * MIN });
  const { game, id } = resolvedWith("yes", { env: short });
  assert.ok(game.resolved[0].check);
  const after = RESOLVED_AT + 3 * MIN;
  assert.equal(resolveJob(game, after, short(after)), undefined, "still checking");
  const checked = applyAiVerdict(game, id, "disagree", after, short(after)).game;
  assert.equal(resolveJob(checked, after + MIN, short(after)), undefined, "waits for an admin");
  const decided = apply(checked, { kind: "decide", id, outcome: "yes" }, admin, after + MIN, short(after));
  assert.deepEqual(resolveJob(decided.game, after + MIN, short(after)), { id, kind: "resolve", outcome: "yes" });
});

test("audit H2: nobody resolved it (auto-cancel): an admin decides; only after 24 hours without one is it voided", () => {
  let game = launched();
  const id = game.live[0].id;
  game = applyMarketDone(game, { id, kind: "create" }, QUESTION, T0, on(T0)).game;
  game = apply(game, { kind: "tick" }, null, LOCK + 60 * MIN, on(LOCK + 60 * MIN)).game;
  assert.equal(game.resolved[0].resolvedBy, "auto");
  const since = game.resolved[0].resolvedAt;
  assert.equal(resolveJob(game, since + MARKET_CHALLENGE_MS), undefined, "no refund just from the streamer staying silent");
  const ticked = apply(game, { kind: "tick" }, null, since + MARKET_DECISION_MS, on(since));
  assert.deepEqual(ticked.game.resolved[0].market?.decision, { outcome: "refund", by: "auto", at: since + MARKET_DECISION_MS });
  assert.deepEqual(resolveJob(ticked.game, since + MARKET_DECISION_MS), { id, kind: "resolve", outcome: "refund" });
  const decided = apply(game, { kind: "decide", id, outcome: "no" }, admin, since + MIN, on(since));
  assert.deepEqual(resolveJob(decided.game, since + MIN), { id, kind: "resolve", outcome: "no" });
});

function challenged(outcome: "yes" | "no" | "cancel" = "yes") {
  const { game, id } = resolvedWith(outcome);
  const r = apply(game, { kind: "challenge", id, reason: "The frame shows he lost the round" }, holder(), RESOLVED_AT + 1_000, on(RESOLVED_AT));
  return { r, id };
}

test("a holder challenges once, posting the bond; the market waits for an admin", () => {
  const { r, id } = challenged();
  assert.equal(delta(r, HOLDER), -CHALLENGE_BOND, "the bond is taken");
  assert.equal(r.moves.get(HOLDER)?.floor, CHALLENGE_BOND, "only if the balance covers it (checked again atomically)");
  assert.deepEqual(r.game.resolved[0].market?.challenge, { by: HOLDER, at: RESOLVED_AT + 1_000, reason: "The frame shows he lost the round", bond: CHALLENGE_BOND });
  assert.equal(resolveJob(r.game, WINDOW_END + MIN), undefined, "no resolve while disputed");
  assert.throws(() => apply(r.game, { kind: "challenge", id, reason: "Me too, it was wrong" }, { ...holder(), wallet: "Other" }, RESOLVED_AT + 2_000, on(RESOLVED_AT)), /already challenged/);
});

test("challenges are refused: non-holders, after the window, a bad reason or link, too few points; a cancel can be challenged", () => {
  const { game, id } = resolvedWith("yes");
  const at = RESOLVED_AT + 1_000;
  const tryIt = (actor: Actor, reason = "The frame shows he lost", link?: string, now = at) =>
    apply(game, { kind: "challenge", id, reason, ...(link ? { link } : {}) }, actor, now, on(now));
  assert.throws(() => tryIt(holder(500, false)), /Only holders/);
  assert.throws(() => tryIt(holder(), "The frame shows he lost", undefined, WINDOW_END), /window is over/);
  assert.throws(() => tryIt(holder(), "no"), /5 to 200 characters/);
  assert.throws(() => tryIt(holder(), "x".repeat(201)), /5 to 200 characters/);
  assert.throws(() => tryIt(holder(), "<b>he lost</b> clearly"), /plain text/i);
  assert.throws(() => tryIt(holder(), "The frame shows he lost", "javascript:alert(1)"), /http\(s\) link/);
  assert.throws(() => tryIt(holder(CHALLENGE_BOND - 1)), /100-point bond/);
  assert.equal(tryIt(holder(), "The frame shows he lost", "https://clips.example/abc").game.resolved[0].market?.challenge?.link, "https://clips.example/abc");
  assert.ok(challenged("cancel").r.game.resolved[0].market?.challenge, "a streamer's cancel is a proposal too");
});

test("admins decide the outcome; the bond follows: upheld (lost), refund (back), the other side (back + reward)", () => {
  const cases: ["yes" | "no" | "cancel", "yes" | "no" | "refund", number][] = [
    ["yes", "yes", 0],
    ["yes", "refund", CHALLENGE_BOND],
    ["yes", "no", CHALLENGE_BOND + OVERTURN_REWARD],
    ["cancel", "refund", 0],
    ["cancel", "yes", CHALLENGE_BOND + OVERTURN_REWARD],
  ];
  for (const [proposed, decided, back] of cases) {
    const { r, id } = challenged(proposed);
    const d = apply(r.game, { kind: "decide", id, outcome: decided }, admin, RESOLVED_AT + MIN, on(RESOLVED_AT));
    assert.equal(delta(d, HOLDER), back, `${proposed} -> ${decided}`);
    assert.deepEqual(resolveJob(d.game, RESOLVED_AT + MIN), { id, kind: "resolve", outcome: decided }, "final at once");
    assert.throws(() => apply(d.game, { kind: "decide", id, outcome: "refund" }, admin, RESOLVED_AT + MIN, on(RESOLVED_AT)), /already decided/);
  }
});

test("audit L4: only admins decide, never the coin's streamer even if listed, and only markets that wait for one", () => {
  const { r, id } = challenged();
  const streamerListed = (now: number) => on(now, { admins: [ADMIN, STREAMER] });
  assert.throws(() => apply(r.game, { kind: "decide", id, outcome: "yes" }, streamer, RESOLVED_AT + MIN, streamerListed(RESOLVED_AT)), /Only a memestream admin/);
  assert.throws(() => apply(r.game, { kind: "decide", id, outcome: "yes" }, viewer("v1"), RESOLVED_AT + MIN, on(RESOLVED_AT)), /Only a memestream admin/);
  const { game, id: plain } = resolvedWith("yes");
  assert.throws(() => apply(game, { kind: "decide", id: plain, outcome: "no" }, admin, RESOLVED_AT + MIN, on(RESOLVED_AT)), /Nothing to decide/);
});

test("a challenge no admin decides within 24 hours is voided: a refund, the bond back, once", () => {
  const { r, id } = challenged("yes");
  const late = RESOLVED_AT + 1_000 + MARKET_DECISION_MS;
  assert.equal(apply(r.game, { kind: "tick" }, null, late - 1, on(late)).game.resolved[0].market?.decision, undefined);
  const t = apply(r.game, { kind: "tick" }, null, late, on(late));
  assert.deepEqual(t.game.resolved[0].market?.decision, { outcome: "refund", by: "auto", at: late });
  assert.equal(delta(t, HOLDER), CHALLENGE_BOND);
  assert.equal(apply(t.game, { kind: "tick" }, null, late + MIN, on(late)).moves.size, 0, "the bond comes back once");
  assert.deepEqual(resolveJob(t.game, late), { id, kind: "resolve", outcome: "refund" });
});
