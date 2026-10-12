import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, apply, applyAiVerdict, applyMarketDone, applyReview, type Env, type Game, marketsDue, newGame, type Result, startMarkets } from "./engine";
import { CHALLENGE_BOND, FLAG_WINDOW_MS, MARKET_CHALLENGE_MS, MARKET_CREATE_MAX_TRIES, MARKET_DECISION_MS, MARKET_RETRY_MS, MAX_HISTORY, OVERTURN_REWARD } from "./rules";

const MIN = 60_000;
const T0 = 1_000_000_000;
const STREAMER = "Streamer";
const QUESTION = "Q".repeat(44);
const viewer = (wallet: string): Actor => ({ wallet, eligible: true, holder: true, balance: 1_000 });
const streamer: Actor = { wallet: STREAMER, eligible: true, holder: false, balance: 0 };
const on = (now: number, extra: Partial<Env> = {}): Env => ({ streamerSeenAt: now - MIN, markets: true, ...extra });
const off = (now: number): Env => ({ streamerSeenAt: now - MIN });

/** The streamer launches a typed question (1-minute window unless given); the review approves it at T0. */
function launched(env: (now: number) => Env = on, windowMin = 1): Game {
  const typed = apply(newGame(STREAMER), { kind: "launch", text: "Will he win this round?", windowMin }, streamer, T0, env(T0)).game;
  return applyReview(typed, typed.pending!, { approved: true }, T0, env(T0)).game;
}

const claim = (game: Game, now: number, env = on(now)) => startMarkets(game, now, env);

test("markets off: a prediction goes live with no market, and no market step is ever due", () => {
  const game = launched(off);
  assert.equal(game.live[0].market, undefined);
  assert.equal(marketsDue(game, T0, off(T0)), false);
  const resolved = apply(game, { kind: "resolve", id: game.live[0].id, outcome: "yes" }, streamer, T0 + MIN, off(T0 + MIN)).game;
  assert.equal(resolved.resolved[0].market, undefined);
  assert.equal(marketsDue(resolved, T0 + MIN + FLAG_WINDOW_MS, off(T0)), false);
  assert.deepEqual(claim(resolved, T0 + MIN + FLAG_WINDOW_MS, off(T0)).jobs, []);
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
  game = apply(game, { kind: "bet", id, side: "yes", amount: 10 }, viewer("v1"), T0 + 30_000, on(T0)).game;

  const lock = T0 + MIN;
  const close = claim(game, lock);
  assert.deepEqual(close.jobs, [{ id, kind: "close" }]);
  game = applyMarketDone(close.game, { id, kind: "close" }, null, lock + 1_000, on(lock)).game;
  assert.equal(game.live[0].market?.step, "closed");

  game = apply(game, { kind: "resolve", id, outcome: "yes" }, streamer, lock + 2_000, on(lock)).game;
  assert.equal(game.resolved[0].market?.step, "closed", "the market moves with the result");
  assert.deepEqual(claim(game, lock + 2_000 + FLAG_WINDOW_MS).jobs, [], "the points flag window doesn't matter: no resolve during the challenge window");
  const after = lock + 2_000 + MARKET_CHALLENGE_MS;
  const resolve = claim(game, after);
  assert.deepEqual(resolve.jobs, [{ id, kind: "resolve", outcome: "yes" }]);
  game = applyMarketDone(resolve.game, resolve.jobs[0], null, after + 1_000, on(after)).game;
  assert.deepEqual(game.resolved[0].market, { step: "resolved", tries: 0, at: after + 1_000, question: QUESTION });
  assert.equal(marketsDue(game, after + 10 * MIN, on(after)), false);
});

/** A live market, open and closed at lock, then resolved by the streamer with `outcome`. */
function closedAndResolved(outcome: "yes" | "no" | "cancel", env: (now: number) => Env = on) {
  let game = launched(env);
  const id = game.live[0].id;
  game = applyMarketDone(game, { id, kind: "create" }, QUESTION, T0, env(T0)).game;
  game = applyMarketDone(game, { id, kind: "close" }, null, T0 + MIN, env(T0)).game;
  game = apply(game, { kind: "bet", id, side: "no", amount: 10 }, viewer("v1"), T0 + 1_000, env(T0)).game;
  game = apply(game, { kind: "resolve", id, outcome }, streamer, T0 + MIN, env(T0 + MIN)).game;
  return { game, id };
}

test("resolve mapping: YES and NO pay their side; a cancel refunds; points flags change nothing", () => {
  const after = T0 + MIN + MARKET_CHALLENGE_MS;
  for (const outcome of ["yes", "no", "cancel"] as const) {
    const { game } = closedAndResolved(outcome);
    assert.deepEqual(claim(game, after).jobs[0], { id: game.resolved[0].id, kind: "resolve", outcome: outcome === "cancel" ? "refund" : outcome });
  }
  const { game, id } = closedAndResolved("yes");
  const flagged = apply(game, { kind: "flag", id }, viewer("v1"), T0 + MIN + 1_000, on(T0)).game;
  assert.equal(flagged.resolved[0].disputed, true, "disputed for the points game");
  assert.deepEqual(claim(flagged, after).jobs[0], { id, kind: "resolve", outcome: "yes" }, "free-points flags can't force a real-SOL refund");
});

test("resolve waits for the AI check; an AI disagree alone refunds", () => {
  const { game, id } = closedAndResolved("yes", (now) => on(now, { aiCheck: true }));
  assert.ok(game.resolved[0].check);
  // A short test window: with the real 2 hours the check is always over by then (its own deadline is shorter).
  const short = (now: number) => on(now, { aiCheck: true, challengeMs: 3 * MIN });
  const after = T0 + MIN + 3 * MIN;
  assert.deepEqual(claim(game, after, short(after)).jobs, [], "still checking");
  const checked = applyAiVerdict(game, id, "disagree", after, short(after)).game;
  assert.deepEqual(claim(checked, after + 1_000, short(after)).jobs[0], { id, kind: "resolve", outcome: "refund" }, "the AI disagree alone refunds");
});

test("idempotent: a step that succeeds twice, or for the wrong step, changes nothing", () => {
  let game = claim(launched(), T0).game;
  const id = game.live[0].id;
  game = applyMarketDone(game, { id, kind: "create" }, QUESTION, T0 + 1_000, on(T0)).game;
  const again = applyMarketDone(game, { id, kind: "create" }, "other", T0 + 2_000, on(T0));
  assert.equal(again.changed, false);
  assert.equal(applyMarketDone(game, { id, kind: "resolve", outcome: "yes" }, null, T0 + 2_000, on(T0)).changed, false, "can't resolve before closing");
  assert.equal(applyMarketDone(game, { id: "999", kind: "close" }, null, T0 + 2_000, on(T0)).changed, false);
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
  const lock = T0 + MIN;
  const failed = apply(game, { kind: "tick" }, null, lock, on(lock)).game;
  assert.equal(failed.live[0].market?.step, "failed");
  assert.deepEqual(claim(failed, lock).jobs, []);
  const late = applyMarketDone(failed, { id, kind: "create" }, QUESTION, lock + 1_000, on(lock)).game;
  assert.equal(late.live[0].market?.step, "open");
  assert.deepEqual(claim(late, lock + 1_000).jobs, [{ id, kind: "close" }], "so its seed comes back");
});

test("a result whose market isn't resolved yet stays in the history past MAX_HISTORY", () => {
  const { game } = closedAndResolved("yes");
  const old = game.resolved[0];
  const filler = Array.from({ length: MAX_HISTORY + 2 }, (_, i) => ({ ...old, id: String(500 + i), market: undefined, open: null }));
  const crowded: Game = { ...game, resolved: [...filler, old] };
  const after = apply(crowded, { kind: "tick" }, null, T0 + MIN + FLAG_WINDOW_MS, on(T0)).game;
  assert.equal(after.resolved.length, MAX_HISTORY + 1);
  assert.equal(after.resolved.at(-1)?.id, old.id);
});

// ---- The challenge window ----

const ADMIN = "Admin";
const HOLDER = "Holder";
const withAdmin = (now: number, extra: Partial<Env> = {}) => on(now, { admins: [ADMIN], ...extra });
const holder = (balance = 500, shares = true): Actor => ({ wallet: HOLDER, eligible: true, holder: true, balance, shares });
const admin: Actor = { wallet: ADMIN, eligible: true, holder: false, balance: 0 };
const RESOLVED_AT = T0 + MIN;
const WINDOW_END = RESOLVED_AT + MARKET_CHALLENGE_MS;
/** The net points change for `wallet` in a result. */
const delta = (r: Result, wallet: string) => r.moves.get(wallet)?.delta ?? 0;

function challenged(outcome: "yes" | "no" = "yes") {
  const { game, id } = closedAndResolved(outcome, withAdmin);
  const r = apply(game, { kind: "challenge", id, reason: "The frame shows he lost the round" }, holder(), RESOLVED_AT + 1_000, withAdmin(RESOLVED_AT));
  return { r, id };
}

test("no challenge: the proposal goes final at the window's end, not before", () => {
  const { game, id } = closedAndResolved("no", withAdmin);
  assert.deepEqual(claim(game, WINDOW_END - 1, withAdmin(WINDOW_END - 1)).jobs, []);
  assert.deepEqual(claim(game, WINDOW_END, withAdmin(WINDOW_END)).jobs, [{ id, kind: "resolve", outcome: "no" }]);
});

test("a test window from the env: shorter windows end sooner", () => {
  const { game, id } = closedAndResolved("yes", withAdmin);
  const short = (now: number) => withAdmin(now, { challengeMs: 3 * MIN });
  assert.deepEqual(claim(game, RESOLVED_AT + 3 * MIN, short(RESOLVED_AT)).jobs, [{ id, kind: "resolve", outcome: "yes" }]);
});

test("a holder challenges once, posting the bond; the market waits for an admin", () => {
  const { r, id } = challenged();
  assert.equal(delta(r, HOLDER), -CHALLENGE_BOND, "the bond is taken");
  assert.equal(r.moves.get(HOLDER)?.floor, CHALLENGE_BOND, "only if the balance covers it (checked again atomically)");
  assert.deepEqual(r.game.resolved[0].market?.challenge, { by: HOLDER, at: RESOLVED_AT + 1_000, reason: "The frame shows he lost the round", bond: CHALLENGE_BOND });
  assert.deepEqual(claim(r.game, WINDOW_END + MIN, withAdmin(WINDOW_END)).jobs, [], "no resolve while disputed");
  assert.throws(() => apply(r.game, { kind: "challenge", id, reason: "Me too, it was wrong" }, { ...holder(), wallet: "Other" }, RESOLVED_AT + 2_000, withAdmin(RESOLVED_AT)), /already challenged/);
});

test("challenges are refused: non-holders, after the window, on a cancel, a bad reason or link, too few points", () => {
  const { game, id } = closedAndResolved("yes", withAdmin);
  const at = RESOLVED_AT + 1_000;
  const tryIt = (actor: Actor, reason = "The frame shows he lost", link?: string, now = at) =>
    apply(game, { kind: "challenge", id, reason, ...(link ? { link } : {}) }, actor, now, withAdmin(now));
  assert.throws(() => tryIt(holder(500, false)), /Only holders/);
  assert.throws(() => tryIt(holder(), "The frame shows he lost", undefined, WINDOW_END), /window is over/);
  assert.throws(() => tryIt(holder(), "no"), /5 to 200 characters/);
  assert.throws(() => tryIt(holder(), "x".repeat(201)), /5 to 200 characters/);
  assert.throws(() => tryIt(holder(), "<b>he lost</b> clearly"), /plain text/i);
  assert.throws(() => tryIt(holder(), "The frame shows he lost", "javascript:alert(1)"), /http\(s\) link/);
  assert.throws(() => tryIt(holder(CHALLENGE_BOND - 1)), /100-point bond/);
  assert.equal(tryIt(holder(), "The frame shows he lost", "https://clips.example/abc").game.resolved[0].market?.challenge?.link, "https://clips.example/abc");
  const cancelled = closedAndResolved("cancel", withAdmin);
  assert.throws(() => apply(cancelled.game, { kind: "challenge", id: cancelled.id, reason: "This was wrong all along" }, holder(), at, withAdmin(at)), /nothing to challenge/);
});

test("an admin upholds: the proposal goes on chain and the bond is lost", () => {
  const { r, id } = challenged("yes");
  assert.throws(() => apply(r.game, { kind: "decide", id, decision: "uphold" }, { ...admin, wallet: STREAMER }, RESOLVED_AT + MIN, withAdmin(RESOLVED_AT)), /Only a memestream admin/, "not the streamer");
  const d = apply(r.game, { kind: "decide", id, decision: "uphold" }, admin, RESOLVED_AT + MIN, withAdmin(RESOLVED_AT));
  assert.equal(delta(d, HOLDER), 0);
  assert.deepEqual(claim(d.game, RESOLVED_AT + MIN, withAdmin(RESOLVED_AT + MIN)).jobs, [{ id, kind: "resolve", outcome: "yes" }], "final at once, no need to wait out the window");
  assert.throws(() => apply(d.game, { kind: "decide", id, decision: "void" }, admin, RESOLVED_AT + MIN, withAdmin(RESOLVED_AT)), /already decided/);
});

test("an admin overturns: the other side wins and the challenger gets the bond back plus the reward", () => {
  const { r, id } = challenged("yes");
  const d = apply(r.game, { kind: "decide", id, decision: "overturn" }, admin, RESOLVED_AT + MIN, withAdmin(RESOLVED_AT));
  assert.equal(delta(d, HOLDER), CHALLENGE_BOND + OVERTURN_REWARD);
  assert.deepEqual(claim(d.game, RESOLVED_AT + MIN, withAdmin(RESOLVED_AT + MIN)).jobs, [{ id, kind: "resolve", outcome: "no" }]);
});

test("an admin voids: a refund, and the bond comes back", () => {
  const { r, id } = challenged("no");
  const d = apply(r.game, { kind: "decide", id, decision: "void" }, admin, RESOLVED_AT + MIN, withAdmin(RESOLVED_AT));
  assert.equal(delta(d, HOLDER), CHALLENGE_BOND);
  assert.deepEqual(claim(d.game, RESOLVED_AT + MIN, withAdmin(RESOLVED_AT + MIN)).jobs, [{ id, kind: "resolve", outcome: "refund" }]);
});

test("no admin decision within 24 hours: auto-void, a refund, the bond back, once", () => {
  const { r, id } = challenged("yes");
  const late = RESOLVED_AT + 1_000 + MARKET_DECISION_MS;
  assert.equal(apply(r.game, { kind: "tick" }, null, late - 1, withAdmin(late)).game.resolved[0].market?.decision, undefined);
  const t = apply(r.game, { kind: "tick" }, null, late, withAdmin(late));
  assert.deepEqual(t.game.resolved[0].market?.decision, { kind: "void", by: "auto", at: late });
  assert.equal(delta(t, HOLDER), CHALLENGE_BOND);
  assert.equal(apply(t.game, { kind: "tick" }, null, late + MIN, withAdmin(late)).moves.size, 0, "the bond comes back once");
  assert.deepEqual(claim(t.game, late, withAdmin(late)).jobs, [{ id, kind: "resolve", outcome: "refund" }]);
});
