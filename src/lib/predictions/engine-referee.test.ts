import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, AI, apply, applyFrame, applyMarketDone, applyReferee, applyReview, applyRule, releaseAiRun, type Env, frameWindowEnd, type Game, GameError, marketFinal, needsAdmin, newGame, type RefereeAnswer, refereeDeadline, refereeState, refereeWhy, type Result, startAi, startMarkets } from "./engine";
import { AI_CHECK_MAX_TRIES, AI_CHECK_RETRY_MS, AI_RUN_LEASE_MS, AUTO_CANCEL_MS, FLAG_WINDOW_MS, FRAMES_AFTER_LOCK_MS, MARKET_CHALLENGE_MS, MARKET_DECISION_MS, MARKET_FRAMES_AFTER_LOCK_MS, REFEREE_GRACE_MS, REFEREE_REASON_MAX } from "./rules";

const MIN = 60_000;
const T0 = 1_000_000_000;
const LOCK = T0 + MIN;
const STREAMER = "Streamer";
const MOD = "Mod";
const ORACLE = "Oracle";
const BETTORS = ["b1", "b2", "b3", "b4"];
const ON: Env = { streamerSeenAt: null, aiCheck: true, admins: [ORACLE] };
const OFF: Env = { streamerSeenAt: null, admins: [ORACLE] };
const MARKETS: Env = { ...ON, markets: true };
const actor = (wallet: string, shares = false): Actor => ({ wallet, eligible: true, holder: true, balance: 1_000_000, shares });
const YES: RefereeAnswer = { outcome: "yes", model: "jev-1.13.0", confidence: 0.9, reason: "The streamer is in the air", frames: [T0, LOCK] };
const refused = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && pattern.test(e.message));
const QUESTION = "Q".repeat(44);

/** Sums each wallet's point movements over the results it takes. */
function ledger() {
  const points = new Map<string, number>();
  const take = (r: Result) => {
    for (const [w, m] of r.moves) points.set(w, (points.get(w) ?? 0) + m.delta);
    return r.game;
  };
  return { points, take };
}

/** The streamer's question live at T0 (1-minute window) with a mod and its rule, bets on both sides; with `market`, its market opened. */
function liveGame(env: Env, l = ledger()) {
  let game = newGame(STREAMER);
  game = l.take(apply(game, { kind: "mod", wallet: MOD, add: true }, actor(STREAMER), T0, env));
  game = l.take(apply(game, { kind: "launch", text: "Will the streamer jump?" }, actor(STREAMER), T0, env));
  game = l.take(applyReview(game, game.pending!, { approved: true, windowMin: 1 }, T0, env));
  const id = game.live[0].id;
  game = l.take(applyRule(game, id, "YES if the streamer is seen in the air", T0, env));
  if (env.markets) game = l.take(applyMarketDone(game, { id, kind: "create" }, QUESTION, T0, env));
  for (const [i, b] of BETTORS.entries()) game = l.take(apply(game, { kind: "bet", id, side: i % 2 ? "yes" : "no", amount: 100 }, actor(b), T0, env));
  return game;
}

/** A picture grabbed at `now`; `shot`: when the CDN says it was taken. */
function grab(game: Game, now: number, hash: string, env = ON, shot?: number) {
  const claim = startAi(game, now, env);
  assert.equal(claim.captures.length, 1, `a grab is due at lock + ${(now - LOCK) / 1000} s`);
  return applyFrame(claim.game, claim.captures[0], { hash, text: `picture ${hash}`, ...(shot !== undefined ? { shot } : {}) }, now, env).game;
}

/** Claims the referee's run at `now`. */
function claimReferee(game: Game, now: number, env = ON) {
  const claim = startAi(game, now, env);
  assert.equal(claim.referees.length, 1, `the referee is due at lock + ${(now - LOCK) / 1000} s`);
  return { game: claim.game, target: claim.referees[0] };
}

/** A prediction whose referee gave up for good: unsure on its run at the frame window's end. */
function gaveUp(env = ON) {
  const game = grab(liveGame(env), LOCK, "b", env);
  const end = frameWindowEnd(game.live[0]);
  const claim = claimReferee(game, end, env);
  return applyReferee(claim.game, claim.target.id, claim.target.tries, { unclear: "unclear" }, end + 1_000, env).game;
}

test("referee: waits for a picture taken after the lock (CDN time, else grab time), or the window's end; never while betting is open", () => {
  let game = grab(liveGame(ON), T0, "a");
  assert.equal(startAi(game, LOCK - 1, ON).referees.length, 0, "not while betting is open");
  assert.deepEqual([refereeState(game.live[0], LOCK - 1, ON), refereeState(game.live[0], LOCK, ON)], [null, "checking"]);
  // A new picture grabbed after the lock, but the CDN says it was made before: not fresh.
  game = grab(game, LOCK, "stale", ON, LOCK - 2 * MIN);
  assert.equal(game.live[0].frames!.at(-1)!.shot, LOCK - 2 * MIN);
  assert.equal(startAi(game, LOCK + 1_000, ON).referees.length, 0, "a stale picture is not evidence of what happened");
  game = grab(game, LOCK + MIN, "fresh", ON, LOCK + 30_000);
  const { target } = claimReferee(game, LOCK + MIN);
  assert.deepEqual([target.rule, target.lockAt, target.tries, target.market], ["YES if the streamer is seen in the air", LOCK, 1, false]);
  // A CDN time later than the grab is capped at the grab.
  const capped = grab(liveGame(ON), LOCK, "c", ON, LOCK + 10 * MIN);
  assert.equal(capped.live[0].frames![0].shot, LOCK);
  // No fresh picture: it runs at the window's end anyway (and will say "no picture").
  const none = grab(liveGame(ON), T0, "a");
  assert.equal(startAi(none, LOCK + FRAMES_AFTER_LOCK_MS - 1, ON).referees.length, 0);
  assert.equal(startAi(none, LOCK + FRAMES_AFTER_LOCK_MS, ON).referees.length, 1);
});

test("frames: grabbing goes on through the whole window, even while the referee waits for its last run", () => {
  let game = grab(liveGame(ON), LOCK, "b");
  const claim = claimReferee(game, LOCK);
  game = applyReferee(claim.game, claim.target.id, 1, { unclear: "unclear" }, LOCK + 1_000, ON).game;
  assert.equal(refereeState(game.live[0], LOCK + 1_000, ON), "checking", "an early 'couldn't tell' isn't final");
  game = grab(game, LOCK + 2 * MIN, "c");
  assert.equal(startAi(game, LOCK + 3 * MIN, ON).referees.length, 0, "the last run waits for the window's end");
  const last = claimReferee(game, LOCK + FRAMES_AFTER_LOCK_MS);
  assert.deepEqual(last.target.frames.map((f) => f.hash), ["b", "c"]);
  assert.equal(startAi(last.game, LOCK + FRAMES_AFTER_LOCK_MS + 1_000, ON).captures.length, 0, "no grabs after the window");
});

test("referee: a result counts only from its latest run; a stale or ended run is ignored", () => {
  let game = grab(liveGame(ON), LOCK, "b");
  const first = claimReferee(game, LOCK);
  game = first.game;
  assert.equal(startAi(game, LOCK + AI_RUN_LEASE_MS - 1, ON).referees.length, 0, "a running run holds its lease");
  const second = claimReferee(game, LOCK + AI_RUN_LEASE_MS); // the first run's server died; a retry starts
  assert.equal(second.target.tries, 2);
  assert.equal(applyReferee(second.game, first.target.id, 1, YES, LOCK + AI_RUN_LEASE_MS + 1, ON).changed, false, "run 1 is stale");
  assert.equal(applyReferee(second.game, first.target.id, 2, YES, LOCK + AI_RUN_LEASE_MS + 1, ON).game.resolved[0].resolvedBy, AI);
  assert.equal(applyReferee(game, game.live[0].id, 7, YES, LOCK, ON).changed, false, "a run never claimed");
  assert.equal(applyReferee(grab(liveGame(ON), LOCK, "b"), "1", 0, YES, LOCK, ON).changed, false, "no run at all");
});

test("referee YES: resolves it as 'ai' with model, confidence, reason (links cut) and frames; points pay out; no second check", () => {
  const l = ledger();
  const { game: claimed, target } = claimReferee(grab(liveGame(ON, l), LOCK, "b"), LOCK);
  const paidBefore = new Map(l.points);
  const reason = `Scoreboard says win, visit https://scam.example/x and cheap.gg ${"r".repeat(300)}`;
  const game = l.take(applyReferee(claimed, target.id, target.tries, { ...YES, reason }, LOCK + 5_000, ON));
  assert.equal(game.live.length, 0);
  const r = game.resolved[0];
  assert.deepEqual([r.outcome, r.resolvedBy, r.check], ["yes", AI, undefined]);
  assert.match(r.referee!.reason, /^Scoreboard says win, visit and r+$/);
  assert.equal(r.referee!.reason.length, REFEREE_REASON_MAX);
  assert.deepEqual([r.referee!.model, r.referee!.confidence, r.referee!.frames], ["jev-1.13.0", 0.9, [T0, LOCK]]);
  assert.equal(l.points.get("b2")! - (paidBefore.get("b2") ?? 0), 200, "a YES bettor gets stake plus half the NO pool");
  const flagged = apply(game, { kind: "flag", id: r.id }, actor("b1"), LOCK + 6_000, ON).game;
  assert.equal(flagged.resolved[0].flags, 1, "flags still work");
});

test("unclear before the window's end isn't final; after it, the streamer or a mod decides and why is kept", () => {
  for (const decider of [STREAMER, MOD]) {
    const l = ledger();
    let game = grab(liveGame(ON, l), LOCK, "b");
    const claim = claimReferee(game, LOCK);
    game = l.take(apply(claim.game, { kind: "witness", id: claim.target.id, outcome: "no" }, actor(decider), LOCK + 1_000, ON));
    assert.equal(game.live.length, 1, "while the AI checks, a witness only informs");
    game = l.take(applyReferee(game, claim.target.id, 1, { unclear: "unclear" }, LOCK + 2_000, ON));
    l.take(apply(game, { kind: "witness", id: claim.target.id, outcome: "yes" }, actor(decider), LOCK + 3_000, ON));
    assert.equal(game.live.length, 1, "not final yet: no decision");
    refused(() => apply(game, { kind: "resolve", id: claim.target.id, outcome: "yes" }, actor(decider), LOCK + 3_000, ON), /memestream oracle/);
  }
  const game = gaveUp();
  const id = game.live[0].id;
  assert.deepEqual([refereeState(game.live[0], LOCK + 7 * MIN, ON), refereeWhy(game.live[0], ON)], ["unclear", "unclear"]);
  const decided = apply(game, { kind: "witness", id, outcome: "yes", note: "jumped on camera" }, actor(MOD), LOCK + 7 * MIN, ON).game;
  const r = decided.resolved[0];
  assert.deepEqual([r.outcome, r.resolvedBy, r.fallback, r.witness?.note], ["yes", MOD, "unclear", "jumped on camera"]);
  assert.ok(r.check, "an AI check still follows the streamer's call");
  assert.equal(needsAdmin(r), null, "points only: no admin needed");
});

test("audit 3-4: a question with an official source is never settled from the stream: no rule, frames or referee; staff decide, a market waits for an admin", () => {
  let game = apply(newGame(STREAMER), { kind: "launch", text: "Will Team A win the final?", source: "https://liquipedia.net/match" }, actor(STREAMER), T0, MARKETS).game;
  game = applyReview(game, game.pending!, { approved: true, windowMin: 1 }, T0, MARKETS).game;
  const id = game.live[0].id;
  game = applyMarketDone(game, { id, kind: "create" }, QUESTION, T0, MARKETS).game;
  for (const t of [T0, LOCK, LOCK + FRAMES_AFTER_LOCK_MS, LOCK + MARKET_FRAMES_AFTER_LOCK_MS]) {
    const claim = startAi(game, t, MARKETS);
    assert.deepEqual([claim.rules.length, claim.captures.length, claim.referees.length], [0, 0, 0], `nothing for the AI at ${t - T0}`);
  }
  assert.deepEqual([refereeState(game.live[0], LOCK, MARKETS), refereeWhy(game.live[0], MARKETS)], ["unclear", "source"], "the streamer decides at once");
  game = apply(game, { kind: "witness", id, outcome: "yes" }, actor(STREAMER), LOCK, MARKETS).game;
  const p = game.resolved[0];
  assert.deepEqual([p.resolvedBy, p.fallback, p.check, needsAdmin(p)?.why], [STREAMER, "source", undefined, "fallback"], "no AI check; an admin settles the market");
});

test("fallback: coins without the AI (Kick, no keys) go to the streamer at the lock, why 'no-keys'", () => {
  let game = liveGame(OFF);
  const id = game.live[0].id;
  refused(() => apply(game, { kind: "witness", id, outcome: "yes" }, actor(STREAMER), LOCK - 1, OFF), /still open/);
  assert.deepEqual([refereeState(game.live[0], LOCK, OFF), refereeWhy(game.live[0], OFF)], ["unclear", "no-keys"]);
  game = apply(game, { kind: "witness", id, outcome: "no" }, actor(STREAMER), LOCK, OFF).game;
  assert.deepEqual([game.resolved[0].outcome, game.resolved[0].resolvedBy, game.resolved[0].fallback, game.resolved[0].check], ["no", STREAMER, "no-keys", undefined]);
});

test("audit 1: a wallet holding the coin's market shares can't be made a mod; an admin holding shares can't resolve or decide", () => {
  const game = liveGame(MARKETS);
  const id = game.live[0].id;
  refused(() => apply(game, { kind: "mod", wallet: "b9", add: true }, { ...actor(STREAMER), modShares: true }, T0, MARKETS), /holds shares/);
  assert.ok(apply(game, { kind: "mod", wallet: "b9", add: true }, actor(STREAMER), T0, MARKETS).game.mods.includes("b9"));
  refused(() => apply(game, { kind: "resolve", id, outcome: "yes" }, actor(ORACLE, true), LOCK, MARKETS), /hold shares of this market/);
  const fallback = apply(liveGame({ ...OFF, markets: true }), { kind: "witness", id, outcome: "yes" }, actor(STREAMER), LOCK, OFF).game;
  refused(() => apply(fallback, { kind: "decide", id, outcome: "yes" }, actor(ORACLE, true), LOCK + MIN, OFF), /hold shares of this market/);
});

test("fallback: a viewer can't decide; staff with a points bet or the market's shares can't decide (an admin must)", () => {
  const game = liveGame(OFF);
  const id = game.live[0].id;
  refused(() => apply(game, { kind: "witness", id, outcome: "yes" }, actor("b1"), LOCK, OFF), /streamer or a mod/);
  const tainted = structuredClone(game);
  tainted.live[0].bets[MOD] = { side: "yes", amount: 10, eligible: true };
  refused(() => apply(tainted, { kind: "witness", id, outcome: "yes" }, actor(MOD), LOCK, OFF), /admin decides/);
  const market = liveGame({ ...OFF, markets: true });
  refused(() => apply(market, { kind: "witness", id, outcome: "yes" }, actor(STREAMER, true), LOCK, OFF), /hold shares of this market/);
  assert.equal(apply(tainted, { kind: "resolve", id, outcome: "yes" }, actor(ORACLE), LOCK, OFF).game.resolved[0].resolvedBy, ORACLE);
});

test("markets: a streamer's fallback call is only a proposal: it waits for an admin, even with no AI at all (fail closed)", () => {
  for (const env of [{ ...OFF, markets: true }, MARKETS]) {
    let game = env.aiCheck ? gaveUp(env) : liveGame(env);
    const id = game.live[0].id;
    const at = env.aiCheck ? LOCK + 12 * MIN : LOCK;
    game = apply(game, { kind: "witness", id, outcome: "yes" }, actor(STREAMER), at, env).game;
    const p = game.resolved[0];
    assert.deepEqual(needsAdmin(p), { why: "fallback", since: at });
    assert.equal(marketFinal(p, at + MARKET_CHALLENGE_MS + 1, env), null, "never final by itself");
    const decided = apply(game, { kind: "decide", id, outcome: "no" }, actor(ORACLE), at + MIN, env).game;
    assert.equal(marketFinal(decided.resolved[0], at + MIN, env), "no", "the admin's call counts");
    const voided = apply(game, { kind: "tick" }, null, at + MARKET_DECISION_MS, env).game;
    assert.equal(voided.resolved[0].market?.decision?.outcome, "refund", "no admin in 24 h: void");
  }
});

test("markets: the referee needs two pictures the CDN dates after the lock (it grabs for longer); one, or grab times alone, are not enough", () => {
  let game = grab(liveGame(MARKETS), LOCK, "b", MARKETS, LOCK);
  assert.equal(frameWindowEnd(game.live[0]), LOCK + MARKET_FRAMES_AFTER_LOCK_MS);
  assert.equal(startAi(game, LOCK + 1_000, MARKETS).referees.length, 0, "one fresh picture: wait for another");
  const undated = grab(game, LOCK + 5 * MIN, "c", MARKETS);
  assert.equal(startAi(undated, LOCK + 5 * MIN + 1_000, MARKETS).referees.length, 0, "no CDN time: not fresh for a market");
  game = grab(game, LOCK + 5 * MIN, "c", MARKETS, LOCK + 4 * MIN);
  const { target } = claimReferee(game, LOCK + 5 * MIN, MARKETS);
  assert.deepEqual([target.market, target.frames.length], [true, 2]);
  const one = claimReferee(grab(liveGame(MARKETS), LOCK, "b", MARKETS), LOCK + MARKET_FRAMES_AFTER_LOCK_MS, MARKETS);
  assert.equal(one.target.frames.length, 1, "at the window's end it runs with what it has (and says one picture)");
});

test("markets: the referee's YES is only a proposal: 2 h to challenge, then final; a challenge goes to an admin", () => {
  let game = grab(grab(liveGame(MARKETS), LOCK, "b", MARKETS, LOCK), LOCK + 5 * MIN, "c", MARKETS, LOCK + 4 * MIN);
  const id = game.live[0].id;
  const claim = claimReferee(game, LOCK + 5 * MIN, MARKETS);
  game = applyReferee(claim.game, id, claim.target.tries, YES, LOCK + 5 * MIN, MARKETS).game;
  const p = game.resolved[0];
  const end = LOCK + 5 * MIN + MARKET_CHALLENGE_MS;
  assert.equal(needsAdmin(p), null);
  assert.equal(marketFinal(p, end - 1, MARKETS), null, "still in its challenge window");
  assert.equal(marketFinal(p, end, MARKETS), "yes");
  assert.deepEqual(startMarkets(game, end, MARKETS).jobs, [{ id, kind: "close" }], "trading closes first");
  const closed = applyMarketDone(game, { id, kind: "close" }, null, end, MARKETS).game;
  assert.deepEqual(startMarkets(closed, end, MARKETS).jobs, [{ id, kind: "resolve", outcome: "yes" }]);
  const challenged = apply(game, { kind: "challenge", id, reason: "He never left the ground" }, actor("b1", true), LOCK + 6 * MIN, MARKETS).game;
  assert.equal(marketFinal(challenged.resolved[0], end, MARKETS), null, "waits for an admin");
});

test("admins can always resolve once betting closes, even while the referee works; a late referee answer is ignored", () => {
  let game = grab(liveGame(ON), LOCK, "b");
  const claim = claimReferee(game, LOCK);
  game = claim.game;
  const id = game.live[0].id;
  refused(() => apply(liveGame(ON), { kind: "resolve", id, outcome: "yes" }, actor(ORACLE), LOCK - 1, ON), /still open/);
  game = apply(game, { kind: "resolve", id, outcome: "cancel" }, actor(ORACLE), LOCK + 1_000, ON).game;
  assert.equal(applyReferee(game, id, claim.target.tries, YES, LOCK + 2_000, ON).changed, false);
});

test("referee: failed runs give their lease back and retry after a pause, three in all; then it couldn't tell, why 'error'", () => {
  let game = grab(liveGame(ON), LOCK, "b");
  const id = game.live[0].id;
  let t = LOCK;
  for (let run = 1; run <= AI_CHECK_MAX_TRIES; run++) {
    const claim = startAi(game, t, ON);
    assert.deepEqual(claim.referees.map((r) => r.tries), [run]);
    game = releaseAiRun(claim.game, id, run, t).game;
    assert.equal(startAi(game, t + AI_CHECK_RETRY_MS - 1, ON).referees.length, 0, "not before the pause");
    t += AI_CHECK_RETRY_MS;
  }
  assert.equal(startAi(game, t, ON).referees.length, 0, "no fourth run");
  game = apply(game, { kind: "tick" }, null, t, ON).game;
  assert.deepEqual([refereeState(game.live[0], t, ON), refereeWhy(game.live[0], ON)], ["unclear", "error"]);
});

test("audit 7: the last referee run is never written off while it holds its lease; its late answer counts", () => {
  let game = grab(liveGame(ON), LOCK, "b");
  const id = game.live[0].id;
  let t = LOCK;
  for (let run = 1; run < AI_CHECK_MAX_TRIES; run++) {
    game = releaseAiRun(startAi(game, t, ON).game, id, run, t).game;
    t += AI_CHECK_RETRY_MS;
  }
  game = startAi(game, t, ON).game; // the last run, slow (busy retries)
  game = apply(game, { kind: "tick" }, null, t + AI_RUN_LEASE_MS - 1, ON).game;
  assert.equal(refereeState(game.live[0], t + AI_RUN_LEASE_MS - 1, ON), "checking", "not written off while it runs");
  game = applyReferee(game, id, AI_CHECK_MAX_TRIES, YES, t + 90_000, ON).game;
  assert.equal(game.resolved[0].resolvedBy, AI, "its answer counts");
});

test("referee: no answer by its deadline (window + grace) means the streamer decides, why 'deadline'", () => {
  let game = grab(liveGame(ON), T0, "a");
  ({ game } = claimReferee(game, LOCK + FRAMES_AFTER_LOCK_MS));
  const deadline = refereeDeadline(game.live[0]);
  assert.equal(deadline, LOCK + FRAMES_AFTER_LOCK_MS + REFEREE_GRACE_MS);
  game = apply(game, { kind: "tick" }, null, deadline - 1, ON).game;
  assert.equal(refereeState(game.live[0], deadline - 1, ON), "checking");
  game = apply(game, { kind: "tick" }, null, deadline, ON).game;
  assert.deepEqual([game.live[0].referee?.unclear, refereeWhy(game.live[0], ON)], [deadline, "deadline"]);
  assert.equal(applyReferee(game, game.live[0].id, 1, YES, deadline, ON).changed, false, "too late");
});

test("nobody decides: the 60-minute auto-cancel still refunds", () => {
  const l = ledger();
  let game = liveGame(ON, l);
  game = l.take(apply(game, { kind: "tick" }, null, LOCK + AUTO_CANCEL_MS, ON));
  assert.deepEqual([game.resolved[0].outcome, game.resolved[0].resolvedBy], ["cancel", "auto"]);
  assert.ok(BETTORS.every((b) => l.points.get(b) === 0), "every stake back");
});

test("referee results count after the flag window like any other", () => {
  const { game: claimed, target } = claimReferee(grab(liveGame(ON), LOCK, "b"), LOCK);
  let game = applyReferee(claimed, target.id, target.tries, YES, LOCK, ON).game;
  game = apply(game, { kind: "tick" }, null, LOCK + FLAG_WINDOW_MS, ON).game;
  assert.equal(game.resolved[0].open, null);
  assert.ok(Object.keys(game.won).length > 0);
});
