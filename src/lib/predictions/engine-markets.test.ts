import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, apply, applyAiVerdict, applyMarketDone, applyReview, type Env, type Game, marketsDue, newGame, startMarkets } from "./engine";
import { FLAG_WINDOW_MS, MARKET_CREATE_MAX_TRIES, MARKET_RETRY_MS, MAX_HISTORY } from "./rules";

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
  assert.equal(marketsDue(game, T0), false);
  const resolved = apply(game, { kind: "resolve", id: game.live[0].id, outcome: "yes" }, streamer, T0 + MIN, off(T0 + MIN)).game;
  assert.equal(resolved.resolved[0].market, undefined);
  assert.equal(marketsDue(resolved, T0 + MIN + FLAG_WINDOW_MS), false);
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

test("full life: create, close at lock, resolve YES only after the flag window", () => {
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
  assert.deepEqual(claim(game, lock + 3_000).jobs, [], "no resolve during the flag window");
  const after = lock + 2_000 + FLAG_WINDOW_MS;
  const resolve = claim(game, after);
  assert.deepEqual(resolve.jobs, [{ id, kind: "resolve", outcome: "yes" }]);
  game = applyMarketDone(resolve.game, resolve.jobs[0], null, after + 1_000, on(after)).game;
  assert.deepEqual(game.resolved[0].market, { step: "resolved", tries: 0, at: after + 1_000, question: QUESTION });
  assert.equal(marketsDue(game, after + 10 * MIN), false);
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

test("resolve mapping: YES and NO pay their side; a cancel or a disputed result refunds", () => {
  const after = T0 + MIN + FLAG_WINDOW_MS;
  for (const outcome of ["yes", "no", "cancel"] as const) {
    const { game } = closedAndResolved(outcome);
    assert.deepEqual(claim(game, after).jobs[0], { id: game.resolved[0].id, kind: "resolve", outcome: outcome === "cancel" ? "refund" : outcome });
  }
  const { game, id } = closedAndResolved("yes");
  const flagged = apply(game, { kind: "flag", id }, viewer("v1"), T0 + MIN + 1_000, on(T0)).game;
  assert.equal(flagged.resolved[0].disputed, true);
  assert.deepEqual(claim(flagged, after).jobs[0], { id, kind: "resolve", outcome: "refund" });
});

test("resolve waits for the AI check, as the points results do", () => {
  const { game, id } = closedAndResolved("yes", (now) => on(now, { aiCheck: true }));
  assert.ok(game.resolved[0].check);
  const after = T0 + MIN + FLAG_WINDOW_MS;
  assert.deepEqual(claim(game, after, on(after, { aiCheck: true })).jobs, [], "still checking");
  const checked = applyAiVerdict(game, id, "disagree", after, on(after)).game;
  assert.deepEqual(claim(checked, after + 1_000).jobs[0], { id, kind: "resolve", outcome: "refund" }, "the AI disagree is a dispute");
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
