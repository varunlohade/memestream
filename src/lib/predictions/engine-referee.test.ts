import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, AI, apply, applyFrame, applyMarketDone, applyReferee, applyReview, type Env, type Game, GameError, marketFinal, newGame, type RefereeAnswer, refereeState, type Result, startAi, startMarkets } from "./engine";
import { AI_CHECK_MAX_TRIES, AI_CHECK_RETRY_MS, AUTO_CANCEL_MS, FLAG_WINDOW_MS, FRAMES_AFTER_LOCK_MS, MARKET_CHALLENGE_MS, MARKET_DECISION_MS, REFEREE_DEADLINE_MS, REFEREE_REASON_MAX } from "./rules";

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
const actor = (wallet: string): Actor => ({ wallet, eligible: true, holder: true, balance: 1_000_000 });
const YES: RefereeAnswer = { outcome: "yes", model: "jev-1.13.0", confidence: 0.9, reason: "The streamer is in the air", frames: [T0, LOCK] };
const refused = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && pattern.test(e.message));

/** Sums each wallet's point movements over the results it takes. */
function ledger() {
  const points = new Map<string, number>();
  const take = (r: Result) => {
    for (const [w, m] of r.moves) points.set(w, (points.get(w) ?? 0) + m.delta);
    return r.game;
  };
  return { points, take };
}

/** The streamer's question live at T0 (1-minute window) with a mod, bets on both sides. */
function liveGame(env: Env, l = ledger()) {
  let game = newGame(STREAMER);
  game = l.take(apply(game, { kind: "mod", wallet: MOD, add: true }, actor(STREAMER), T0, env));
  game = l.take(apply(game, { kind: "launch", text: "Will the streamer jump?" }, actor(STREAMER), T0, env));
  game = l.take(applyReview(game, game.pending!, { approved: true, windowMin: 1, rule: "YES if the streamer is seen in the air" }, T0, env));
  for (const [i, b] of BETTORS.entries()) game = l.take(apply(game, { kind: "bet", id: game.live[0].id, side: i % 2 ? "yes" : "no", amount: 100 }, actor(b), T0, env));
  return game;
}

/** A picture grabbed at `now` (the claim and its description). */
function grab(game: Game, now: number, hash: string, env = ON) {
  const claim = startAi(game, now, env);
  assert.equal(claim.captures.length, 1);
  return applyFrame(claim.game, claim.captures[0], { hash, text: `picture ${hash}` }, now, env).game;
}

/** Claims the referee's run at `now`. */
function claimReferee(game: Game, now: number, env = ON) {
  const claim = startAi(game, now, env);
  assert.equal(claim.referees.length, 1, `the referee is due at lock + ${(now - LOCK) / 1000} s`);
  return { game: claim.game, target: claim.referees[0] };
}

test("referee: waits for a picture from after the lock, or 6 minutes; never while betting is open", () => {
  let game = grab(liveGame(ON), T0, "a");
  assert.equal(startAi(game, LOCK - 1, ON).referees.length, 0, "not while betting is open");
  assert.equal(refereeState(game.live[0], LOCK - 1, ON), null);
  assert.equal(refereeState(game.live[0], LOCK, ON), "checking");
  const sameOld = startAi(game, LOCK, ON);
  assert.equal(sameOld.referees.length, 0, "no fresh picture yet: grab instead");
  game = applyFrame(sameOld.game, sameOld.captures[0], { hash: "a", text: "the same picture" }, LOCK).game;
  assert.equal(startAi(game, LOCK + FRAMES_AFTER_LOCK_MS - 1, ON).referees.length, 0);
  assert.equal(startAi(game, LOCK + FRAMES_AFTER_LOCK_MS, ON).referees.length, 1, "6 minutes after the lock it decides anyway");

  let fresh = grab(liveGame(ON), T0, "a");
  fresh = grab(fresh, LOCK + 10_000, "b");
  const { target } = claimReferee(fresh, LOCK + 10_000);
  assert.deepEqual([target.rule, target.lockAt, target.tries, target.frames.map((f) => f.hash)], ["YES if the streamer is seen in the air", LOCK, 1, ["a", "b"]]);
});

test("referee: claimed once; no more grabs once it starts; none on coins without the AI", () => {
  const { game } = claimReferee(grab(liveGame(ON), LOCK, "b"), LOCK);
  const again = startAi(game, LOCK + 1_000, ON);
  assert.deepEqual([again.referees.length, again.captures.length], [0, 0]);
  assert.equal(startAi(liveGame(OFF), LOCK + FRAMES_AFTER_LOCK_MS, OFF).referees.length, 0);
});

test("referee YES: resolves it as 'ai' with model, confidence, reason and frames; points pay out; no second check", () => {
  const l = ledger();
  const { game: claimed } = claimReferee(grab(liveGame(ON, l), LOCK, "b"), LOCK);
  const paidBefore = new Map(l.points);
  const game = l.take(applyReferee(claimed, claimed.live[0].id, { ...YES, reason: "r".repeat(300) }, LOCK + 5_000, ON));
  assert.equal(game.live.length, 0);
  const r = game.resolved[0];
  assert.deepEqual([r.outcome, r.resolvedBy, r.check], ["yes", AI, undefined]);
  assert.deepEqual(r.referee, { model: "jev-1.13.0", confidence: 0.9, reason: "r".repeat(REFEREE_REASON_MAX), frames: [T0, LOCK] });
  assert.notDeepEqual(l.points, paidBefore, "the winners were paid");
  assert.equal(l.points.get("b2")! - (paidBefore.get("b2") ?? 0), 200, "a YES bettor gets stake plus half the NO pool");
  assert.equal(game.resolved[0].open !== null, true, "flags still work: the flag window is open");
  const flagged = apply(game, { kind: "flag", id: r.id }, actor("b1"), LOCK + 6_000, ON).game;
  assert.equal(flagged.resolved[0].flags, 1);
});

test("referee unclear: the streamer or a mod decides; their witness becomes the resolve, once", () => {
  for (const decider of [STREAMER, MOD]) {
    const l = ledger();
    let game = grab(liveGame(ON, l), LOCK, "b");
    ({ game } = claimReferee(game, LOCK));
    const id = game.live[0].id;
    // While the referee works, a witness only informs.
    game = l.take(apply(game, { kind: "witness", id, outcome: "no" }, actor(decider), LOCK + 1_000, ON));
    assert.equal(game.live.length, 1, "no resolve while the AI checks");
    game = l.take(applyReferee(game, id, "unclear", LOCK + 2_000, ON));
    assert.equal(refereeState(game.live[0], LOCK + 2_000, ON), "unclear");
    assert.equal(game.live.length, 1, "unclear resolves nothing");
    game = l.take(apply(game, { kind: "witness", id, outcome: "yes", note: "jumped on camera" }, actor(decider), LOCK + 3_000, ON));
    const r = game.resolved[0];
    assert.deepEqual([r.outcome, r.resolvedBy, r.witness?.note], ["yes", decider, "jumped on camera"]);
    assert.ok(r.check, "an AI check still follows the streamer's call");
    assert.equal(l.points.get("b2"), 100, "b2 bet 100 and got 200 back");
    refused(() => apply(game, { kind: "witness", id, outcome: "no" }, actor(decider), LOCK + 4_000, ON), /Nothing to answer|already final/);
  }
});

test("fallback: coins without the AI (Kick, no keys) go straight to the streamer once betting closes", () => {
  let game = liveGame(OFF);
  const id = game.live[0].id;
  refused(() => apply(game, { kind: "witness", id, outcome: "yes" }, actor(STREAMER), LOCK - 1, OFF), /still open/);
  assert.equal(refereeState(game.live[0], LOCK, OFF), "unclear");
  game = apply(game, { kind: "witness", id, outcome: "no" }, actor(STREAMER), LOCK, OFF).game;
  assert.deepEqual([game.resolved[0].outcome, game.resolved[0].resolvedBy, game.resolved[0].check], ["no", STREAMER, undefined]);
});

test("fallback: a viewer can't decide; a staff wallet with a bet on it can't decide (an admin must)", () => {
  const game = liveGame(OFF);
  const id = game.live[0].id;
  refused(() => apply(game, { kind: "witness", id, outcome: "yes" }, actor("b1"), LOCK, OFF), /streamer or a mod/);
  // A mod who held a bet from before (stored state from older rules): no deciding their own bet.
  const tainted = structuredClone(game);
  tainted.live[0].bets[MOD] = { side: "yes", amount: 10, eligible: true };
  refused(() => apply(tainted, { kind: "witness", id, outcome: "yes" }, actor(MOD), LOCK, OFF), /admin decides/);
  const byAdmin = apply(tainted, { kind: "resolve", id, outcome: "yes" }, actor(ORACLE), LOCK, OFF).game;
  assert.equal(byAdmin.resolved[0].resolvedBy, ORACLE);
});

test("admins can always resolve once betting closes, even while the referee works; a late referee answer is ignored", () => {
  let game = grab(liveGame(ON), LOCK, "b");
  ({ game } = claimReferee(game, LOCK));
  const id = game.live[0].id;
  refused(() => apply(liveGame(ON), { kind: "resolve", id, outcome: "yes" }, actor(ORACLE), LOCK - 1, ON), /still open/);
  game = apply(game, { kind: "resolve", id, outcome: "cancel" }, actor(ORACLE), LOCK + 1_000, ON).game;
  const late = applyReferee(game, id, YES, LOCK + 2_000, ON);
  assert.equal(late.changed, false);
  assert.equal(late.game.resolved[0].outcome, "cancel");
});

test("referee: an answer without a claimed run, or after it gave up, is ignored", () => {
  const game = grab(liveGame(ON), LOCK, "b");
  assert.equal(applyReferee(game, game.live[0].id, YES, LOCK, ON).changed, false, "not claimed");
  const { game: claimed } = claimReferee(game, LOCK);
  const gaveUp = applyReferee(claimed, claimed.live[0].id, "unclear", LOCK + 1_000, ON).game;
  assert.equal(applyReferee(gaveUp, gaveUp.live[0].id, YES, LOCK + 2_000, ON).changed, false);
});

test("referee: failed runs retry after a pause, three in all; then it couldn't tell", () => {
  let game = grab(liveGame(ON), LOCK, "b");
  let t = LOCK;
  for (let run = 1; run <= AI_CHECK_MAX_TRIES; run++) {
    const claim = startAi(game, t, ON);
    assert.deepEqual(claim.referees.map((r) => r.tries), [run]);
    game = claim.game;
    assert.equal(startAi(game, t + AI_CHECK_RETRY_MS - 1, ON).referees.length, 0, "not before the pause");
    t += AI_CHECK_RETRY_MS;
  }
  assert.equal(startAi(game, t, ON).referees.length, 0, "no fourth run");
  game = apply(game, { kind: "tick" }, null, t, ON).game;
  assert.equal(refereeState(game.live[0], t, ON), "unclear");
});

test("referee: no answer by its deadline (no runs, keys removed, a hung run) means the streamer decides", () => {
  let game = grab(liveGame(ON), T0, "a");
  ({ game } = claimReferee(game, LOCK + FRAMES_AFTER_LOCK_MS));
  game = apply(game, { kind: "tick" }, null, LOCK + REFEREE_DEADLINE_MS - 1, ON).game;
  assert.equal(refereeState(game.live[0], LOCK + REFEREE_DEADLINE_MS - 1, ON), "checking");
  game = apply(game, { kind: "tick" }, null, LOCK + REFEREE_DEADLINE_MS, ON).game;
  assert.equal(game.live[0].referee?.unclear, LOCK + REFEREE_DEADLINE_MS);
  assert.equal(applyReferee(game, game.live[0].id, YES, LOCK + REFEREE_DEADLINE_MS, ON).changed, false, "too late");
  game = apply(game, { kind: "witness", id: game.live[0].id, outcome: "no" }, actor(STREAMER), LOCK + REFEREE_DEADLINE_MS + 1, ON).game;
  assert.equal(game.resolved[0].resolvedBy, STREAMER);
});

test("nobody decides: the 60-minute auto-cancel still refunds", () => {
  const l = ledger();
  let game = liveGame(ON, l);
  game = l.take(apply(game, { kind: "tick" }, null, LOCK + AUTO_CANCEL_MS, ON));
  assert.deepEqual([game.resolved[0].outcome, game.resolved[0].resolvedBy], ["cancel", "auto"]);
  assert.ok(BETTORS.every((b) => l.points.get(b) === 0), "every stake back");
});

test("markets: the referee's YES is only a proposal: 2 h to challenge, then final; a challenge goes to an admin", () => {
  let game = liveGame(MARKETS);
  const id = game.live[0].id;
  game = applyMarketDone(game, { id, kind: "create" }, "Q".repeat(44), T0, MARKETS).game;
  game = grab(game, LOCK, "b", MARKETS);
  ({ game } = claimReferee(game, LOCK, MARKETS));
  game = applyReferee(game, id, YES, LOCK + 1_000, MARKETS).game;
  const p = game.resolved[0];
  assert.equal(marketFinal(p, LOCK + 1_000 + MARKET_CHALLENGE_MS - 1, MARKETS), null, "still in its challenge window");
  assert.equal(marketFinal(p, LOCK + 1_000 + MARKET_CHALLENGE_MS, MARKETS), "yes");
  const resolveJobs = startMarkets(game, LOCK + 1_000 + MARKET_CHALLENGE_MS, MARKETS).jobs.filter((j) => j.kind === "resolve");
  assert.deepEqual(resolveJobs, [{ id, kind: "resolve", outcome: "yes" }]);

  const challenged = apply(game, { kind: "challenge", id, reason: "He never left the ground" }, { ...actor("b1"), shares: true }, LOCK + 2_000, MARKETS).game;
  assert.equal(marketFinal(challenged.resolved[0], LOCK + 1_000 + MARKET_CHALLENGE_MS, MARKETS), null, "waits for an admin");
  const overturned = apply(challenged, { kind: "decide", id, outcome: "no" }, actor(ORACLE), LOCK + 3_000, MARKETS).game;
  assert.equal(marketFinal(overturned.resolved[0], LOCK + 3_000, MARKETS), "no");
  const voided = apply(challenged, { kind: "tick" }, null, LOCK + 2_000 + MARKET_DECISION_MS, MARKETS).game;
  assert.equal(voided.resolved[0].market?.decision?.outcome, "refund", "no admin in 24 h: void");
});

test("markets: the streamer's fallback decision also waits out the challenge window", () => {
  let game = liveGame({ ...OFF, markets: true });
  const id = game.live[0].id;
  game = applyMarketDone(game, { id, kind: "create" }, "Q".repeat(44), T0, OFF).game;
  game = apply(game, { kind: "witness", id, outcome: "yes" }, actor(STREAMER), LOCK, OFF).game;
  assert.equal(marketFinal(game.resolved[0], LOCK + MARKET_CHALLENGE_MS - 1, OFF), null);
  assert.equal(marketFinal(game.resolved[0], LOCK + MARKET_CHALLENGE_MS, OFF), "yes");
});

test("referee results count after the flag window like any other", () => {
  let game = grab(liveGame(ON), LOCK, "b");
  ({ game } = claimReferee(game, LOCK));
  game = applyReferee(game, game.live[0].id, YES, LOCK, ON).game;
  game = apply(game, { kind: "tick" }, null, LOCK + FLAG_WINDOW_MS, ON).game;
  assert.equal(game.resolved[0].open, null);
  assert.ok(Object.keys(game.won).length > 0);
});
