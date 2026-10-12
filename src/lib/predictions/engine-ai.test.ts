import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, aiDue, apply, applyAiVerdict, applyFrame, applyReview, type Env, type Game, newGame, type Result, startAi } from "./engine";
import { AI_CHECK_MAX_TRIES, AI_CHECK_MAX_WAIT_MS, AI_CHECK_RETRY_MS, ASKER_REWARD, FLAG_WINDOW_MS, FRAME_NOTE_MAX } from "./rules";

const MIN = 60_000;
const T0 = 1_000_000_000;
const STREAMER = "Streamer";
const ASKER = "Asker";
const BETTORS = ["b1", "b2", "b3", "b4", "b5", "b6"];
const ON: Env = { streamerSeenAt: null, aiCheck: true };
const OFF: Env = { streamerSeenAt: null };
const actor = (wallet: string): Actor => ({ wallet, eligible: true, holder: true, balance: 1_000_000 });

/** Applies every action, summing each wallet's point movements and the leaderboard changes. */
function ledger() {
  const points = new Map<string, number>();
  const won = new Map<string, number>();
  const take = (r: Result) => {
    for (const [w, m] of r.moves) points.set(w, (points.get(w) ?? 0) + m.delta);
    for (const [w, d] of r.won) won.set(w, (won.get(w) ?? 0) + d);
    return r.game;
  };
  return { points, won, take };
}

/** A viewer's question live (launched at T0, locks at T0 + 1 min), six eligible bettors on both sides. */
function liveGame(env: Env, l = ledger()) {
  let game = newGame(STREAMER);
  game = l.take(apply(game, { kind: "suggest", text: "Will the streamer jump?" }, actor(ASKER), T0, env));
  game = l.take(applyReview(game, game.suggestions[0], { approved: true }, T0, env));
  game = l.take(apply(game, { kind: "launch", id: game.suggestions[0].id, windowMin: 1 }, actor(STREAMER), T0, env));
  for (const [i, b] of BETTORS.entries()) game = l.take(apply(game, { kind: "bet", id: game.live[0].id, side: i % 2 ? "yes" : "no", amount: 100 }, actor(b), T0, env));
  return game;
}

const resolveYesResult = (game: Game, env: Env, now = T0 + MIN) => apply(game, { kind: "resolve", id: game.live[0].id, outcome: "yes" }, actor(STREAMER), now, env);
const resolveYes = (game: Game, env: Env, now = T0 + MIN) => resolveYesResult(game, env, now).game;

test("frames: launch is grabbed at once, lock once betting closes, each claimed once; none without the AI check", () => {
  let game = liveGame(ON);
  assert.equal(aiDue(game, T0, ON), true);
  const first = startAi(game, T0, ON);
  assert.deepEqual(first.captures.map((c) => c.kind), ["launch"]);
  game = first.game;
  assert.equal(aiDue(game, T0, ON), false, "claimed: no second grab");
  assert.deepEqual(startAi(game, T0 + 30_000, ON).captures, []);
  const lock = startAi(game, T0 + MIN, ON);
  assert.deepEqual(lock.captures.map((c) => c.kind), ["lock"]);
  game = applyFrame(lock.game, lock.captures[0], "x".repeat(FRAME_NOTE_MAX + 50), T0 + MIN).game;
  game = applyFrame(game, first.captures[0], "A person at a desk", T0 + MIN).game;
  assert.deepEqual(game.live[0].frames!.map((f) => [f.kind, f.text?.length]), [["launch", 18], ["lock", FRAME_NOTE_MAX]]);
  assert.equal(applyFrame(game, first.captures[0], "again", T0 + MIN).changed, false, "a filled note is not overwritten");

  const off = liveGame(OFF);
  assert.equal(aiDue(off, T0 + MIN, OFF), false);
  assert.deepEqual(startAi(off, T0 + MIN, OFF).captures, []);
});

test("frames and checks are per prediction when several are live", () => {
  let game = liveGame(ON);
  game = apply(game, { kind: "launch", text: "Will chat win this round?", windowMin: 2 }, actor(STREAMER), T0, ON).game;
  game = applyReview(game, game.pending!, { approved: true }, T0, ON).game;
  const [p1, p2] = game.live.map((p) => p.id);
  const launch = startAi(game, T0, ON);
  assert.deepEqual(launch.captures.map((c) => [c.id, c.kind]), [[p1, "launch"], [p2, "launch"]]);
  game = applyFrame(launch.game, launch.captures[1], "Chat is cheering", T0).game;
  const lock1 = startAi(game, T0 + MIN, ON);
  assert.deepEqual(lock1.captures.map((c) => [c.id, c.kind]), [[p1, "lock"]], "each locks on its own clock");
  game = lock1.game;
  game = apply(game, { kind: "resolve", id: p1, outcome: "yes" }, actor(STREAMER), T0 + MIN, ON).game;
  assert.deepEqual(startAi(game, T0 + 2 * MIN, ON).captures.map((c) => [c.id, c.kind]), [[p2, "lock"]]);
  game = apply(game, { kind: "resolve", id: p2, outcome: "no" }, actor(STREAMER), T0 + 2 * MIN, ON).game;
  const checks = startAi(game, T0 + 2 * MIN, ON).checks;
  assert.deepEqual(
    checks.map((c) => [c.id, c.outcome, c.frames.map((f) => [f.kind, f.text])]).sort(),
    [
      [p1, "yes", [["launch", null], ["lock", null]]],
      [p2, "no", [["launch", "Chat is cheering"]]],
    ],
  );
});

test("resolve YES/NO starts a check carrying the frames; cancel and coins without the check get none", () => {
  let game = startAi(liveGame(ON), T0, ON).game;
  game = applyFrame(game, { id: game.live[0].id, text: game.live[0].text, kind: "launch" }, "A person at a desk", T0).game;
  game = resolveYes(game, ON);
  assert.deepEqual(game.resolved[0].check, { tries: 0, at: T0 + MIN, frames: [{ kind: "launch", at: T0, text: "A person at a desk" }] });
  const claim = startAi(game, T0 + MIN, ON);
  assert.deepEqual(claim.checks.map((c) => [c.outcome, c.tries, c.frames.length]), [["yes", 1, 1]]);
  assert.equal(aiDue(claim.game, T0 + MIN + 1, ON), false, "a claimed run isn't started twice");

  const live = liveGame(ON);
  const cancelled = apply(live, { kind: "resolve", id: live.live[0].id, outcome: "cancel" }, actor(STREAMER), T0 + MIN, ON).game;
  assert.equal(cancelled.resolved[0].check, undefined);
  assert.equal(resolveYes(liveGame(OFF), OFF).resolved[0].check, undefined);
});

test("agree and unclear only tag the result; payouts never change and the result counts as usual", () => {
  for (const verdict of ["agree", "unclear"] as const) {
    const l = ledger();
    let game = l.take(resolveYesResult(liveGame(ON, l), ON));
    const paid = new Map(l.points);
    game = l.take(applyAiVerdict(game, game.resolved[0].id, verdict, T0 + MIN + 5_000));
    assert.deepEqual(game.resolved[0].ai, { verdict, at: T0 + MIN + 5_000 });
    assert.equal(game.resolved[0].disputed, false);
    assert.deepEqual(l.points, paid, "the verdict moves no points");
    game = l.take(apply(game, { kind: "tick" }, null, T0 + MIN + FLAG_WINDOW_MS));
    assert.equal(game.resolved[0].askerReward, ASKER_REWARD);
    assert.ok(l.won.size > 0, "winnings count on the leaderboard");
  }
});

test("disagree marks the result disputed: no leaderboard, no asker reward, payouts unchanged", () => {
  const l = ledger();
  let game = l.take(resolveYesResult(liveGame(ON, l), ON));
  const paid = new Map(l.points);
  game = l.take(applyAiVerdict(game, game.resolved[0].id, "disagree", T0 + MIN + 5_000));
  assert.equal(game.resolved[0].disputed, true);
  assert.deepEqual(l.points, paid);
  game = l.take(apply(game, { kind: "tick" }, null, T0 + MIN + FLAG_WINDOW_MS));
  assert.equal(game.resolved[0].open, null);
  assert.deepEqual([game.resolved[0].askerReward, l.won.size, game.won], [0, 0, {}]);
});

test("a disagree after the flag window still disputes: the result waits for its check before it counts", () => {
  const l = ledger();
  let game = l.take(resolveYesResult(liveGame(ON, l), ON));
  game = l.take(startAi(game, T0 + MIN, ON));
  const late = T0 + MIN + FLAG_WINDOW_MS + 1;
  game = l.take(apply(game, { kind: "tick" }, null, late));
  assert.ok(game.resolved[0].open, "past its window, still open while the check runs");
  assert.equal(l.won.size, 0);
  assert.throws(() => apply(game, { kind: "flag", id: game.resolved[0].id }, actor("b1"), late), /Too late to flag/);
  game = l.take(applyAiVerdict(game, game.resolved[0].id, "disagree", late));
  assert.deepEqual([game.resolved[0].disputed, game.resolved[0].open, game.resolved[0].askerReward, l.won.size], [true, null, 0, 0]);
});

test("a verdict for a result already checked (or never checked) is ignored", () => {
  let game = resolveYes(liveGame(ON), ON);
  const id = game.resolved[0].id;
  game = applyAiVerdict(game, id, "agree", T0 + MIN + 1_000).game;
  const again = applyAiVerdict(game, id, "disagree", T0 + MIN + 2_000);
  assert.equal(again.changed, false);
  assert.deepEqual([again.game.resolved[0].ai?.verdict, again.game.resolved[0].disputed], ["agree", false]);
  const unchecked = resolveYes(liveGame(OFF), OFF);
  assert.equal(applyAiVerdict(unchecked, unchecked.resolved[0].id, "disagree", T0 + MIN).changed, false);
});

test("no evidence (null verdict) ends the check with no tag", () => {
  let game = resolveYes(liveGame(ON), ON);
  game = applyAiVerdict(game, game.resolved[0].id, null, T0 + MIN + 1_000).game;
  assert.deepEqual([game.resolved[0].check, game.resolved[0].ai, game.resolved[0].disputed], [undefined, undefined, false]);
});

test("failed runs retry after a pause, at most twice; then the result shows couldn't tell", () => {
  let game = resolveYes(liveGame(ON), ON);
  let t = T0 + MIN;
  for (let run = 1; run <= AI_CHECK_MAX_TRIES; run++) {
    const claim = startAi(game, t, ON);
    assert.deepEqual(claim.checks.map((c) => c.tries), [run]);
    game = claim.game;
    assert.equal(startAi(game, t + AI_CHECK_RETRY_MS - 1, ON).checks.length, 0, "not before the pause");
    t += AI_CHECK_RETRY_MS;
  }
  assert.equal(startAi(game, t, ON).checks.length, 0, "no fourth run");
  game = apply(game, { kind: "tick" }, null, t).game;
  assert.deepEqual([game.resolved[0].check, game.resolved[0].ai?.verdict, game.resolved[0].disputed], [undefined, "unclear", false]);
});

test("a check that never runs (keys removed, AI off) ends as couldn't tell at its hard deadline, and the result counts", () => {
  let game = resolveYes(liveGame(ON), ON);
  assert.ok(game.resolved[0].check, "a check is waiting");
  const deadline = game.resolved[0].resolvedAt + FLAG_WINDOW_MS + AI_CHECK_MAX_WAIT_MS;
  game = apply(game, { kind: "tick" }, null, deadline - 1, OFF).game;
  assert.ok(game.resolved[0].check, "still waiting just before the deadline");
  game = apply(game, { kind: "tick" }, null, deadline, OFF).game;
  assert.equal(game.resolved[0].check, undefined);
  assert.equal(game.resolved[0].ai?.verdict, "unclear");
  game = apply(game, { kind: "tick" }, null, deadline + 1, OFF).game;
  assert.equal(game.resolved[0].open, null, "the result counts once its check ended");
});
