import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, aiDue, apply, applyAiVerdict, applyFrame, applyReview, applyRule, releaseAiRun, type CaptureTarget, type Env, type Game, newGame, type Result, startAi } from "./engine";
import { AI_CHECK_MAX_TRIES, AI_CHECK_MAX_WAIT_MS, AI_CHECK_RETRY_MS, AI_RUN_LEASE_MS, ASKER_REWARD, FLAG_WINDOW_MS, FRAME_GAP_MS, FRAME_NOTE_MAX, FRAMES_AFTER_LOCK_MS, MAX_FRAME_NOTES } from "./rules";

const MIN = 60_000;
const T0 = 1_000_000_000;
const STREAMER = "Streamer";
const ASKER = "Asker";
const BETTORS = ["b1", "b2", "b3", "b4", "b5", "b6"];
const ORACLE = "Oracle";
const ON: Env = { streamerSeenAt: null, aiCheck: true, admins: [ORACLE] };
const OFF: Env = { streamerSeenAt: null, admins: [ORACLE] };
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

/** A viewer's question live (launched at T0, locks at T0 + `windowMin`), six eligible bettors on both sides. */
function liveGame(env: Env, l = ledger(), windowMin = 1) {
  let game = newGame(STREAMER);
  game = l.take(apply(game, { kind: "suggest", text: "Will the streamer jump?" }, actor(ASKER), T0, env));
  game = l.take(applyReview(game, game.suggestions[0], { approved: true, windowMin }, T0, env));
  game = l.take(apply(game, { kind: "launch", id: game.suggestions[0].id }, actor(STREAMER), T0, env));
  game = l.take(applyRule(game, game.live[0].id, "YES if the streamer is seen in the air", T0, env));
  for (const [i, b] of BETTORS.entries()) game = l.take(apply(game, { kind: "bet", id: game.live[0].id, side: i % 2 ? "yes" : "no", amount: 100 }, actor(b), T0, env));
  return game;
}

const resolveYesResult = (game: Game, env: Env, now = T0 + MIN) => apply(game, { kind: "resolve", id: game.live[0].id, outcome: "yes" }, actor(ORACLE), now, env);
const resolveYes = (game: Game, env: Env, now = T0 + MIN) => resolveYesResult(game, env, now).game;
/** Claims a grab at `now` and saves picture `hash` for it. */
function grab(game: Game, now: number, hash: string, text = `picture ${hash}`): { game: Game; target: CaptureTarget } {
  const claim = startAi(game, now, ON);
  assert.equal(claim.captures.length, 1, `a grab is due at ${now - T0}`);
  return { game: applyFrame(claim.game, claim.captures[0], { hash, text }, now, ON).game, target: claim.captures[0] };
}

test("check rule: written once the question is live (not at approval), at most twice; cleaned, links cut, cut to 200; never replaced", () => {
  let game = apply(newGame(STREAMER), { kind: "suggest", text: "Will chat win?" }, actor(ASKER), T0, ON).game;
  game = applyReview(game, game.suggestions[0], { approved: true, windowMin: 1 }, T0, ON).game;
  assert.deepEqual(startAi(game, T0, ON).rules, [], "an approved suggestion gets no rule yet");
  game = apply(game, { kind: "launch", id: game.suggestions[0].id }, actor(STREAMER), T0, ON).game;
  const id = game.live[0].id;
  const first = startAi(game, T0, ON);
  assert.deepEqual(first.rules, [{ id, text: "Will chat win?" }]);
  assert.deepEqual(startAi(first.game, T0 + 1_000, ON).rules, [], "claimed: not twice at once");
  const second = startAi(first.game, T0 + AI_RUN_LEASE_MS, ON);
  assert.equal(second.rules.length, 1, "a failed write is tried once more");
  assert.deepEqual(startAi(second.game, T0 + 2 * AI_RUN_LEASE_MS, ON).rules, [], "then the question alone");
  const written = applyRule(second.game, id, `  YES if\n chat wins, see https://evil.example/x or scam.io ${"x".repeat(300)}`, T0, ON).game;
  assert.match(written.live[0].rule!, /^YES if chat wins, see or x+$/);
  assert.equal(written.live[0].rule!.length, 200);
  assert.equal(applyRule(written, id, "NO always", T0, ON).changed, false, "a rule is never replaced");
  assert.equal(applyRule(second.game, id, "   ", T0, ON).game.live[0].rule, undefined);
  assert.deepEqual(startAi(liveGame(OFF), T0, OFF).rules, [], "no AI, no rule");
});

test("frames: a grab at launch, then at most every FRAME_GAP_MS while live and up to 6 minutes after the lock; none without the AI", () => {
  let game = liveGame(ON, ledger(), 5);
  assert.equal(aiDue(game, T0, ON), true);
  const first = startAi(game, T0, ON);
  assert.deepEqual(first.captures.map((c) => [c.kind, c.at, c.rule, c.hashes]), [["launch", T0, "YES if the streamer is seen in the air", []]]);
  game = first.game;
  assert.equal(aiDue(game, T0 + FRAME_GAP_MS - 1, ON), false, "claimed: no second grab before the gap");
  game = applyFrame(game, first.captures[0], { hash: "a", text: "A person at a desk" }, T0 + 1_000).game;
  const second = startAi(game, T0 + FRAME_GAP_MS, ON);
  assert.deepEqual(second.captures.map((c) => [c.kind, c.hashes]), [["live", ["a"]]]);
  const lock = T0 + 5 * MIN;
  assert.deepEqual(startAi(game, lock, ON).captures.map((c) => c.kind), ["after"]);
  assert.deepEqual(startAi(game, lock + FRAMES_AFTER_LOCK_MS - 1, ON).captures.map((c) => c.kind), ["after"]);
  assert.deepEqual(startAi(game, lock + FRAMES_AFTER_LOCK_MS, ON).captures, [], "no grabs 6 minutes after the lock");

  const off = liveGame(OFF);
  assert.equal(aiDue(off, T0, OFF), false);
  assert.deepEqual(startAi(off, T0, OFF).captures, []);
});

test("frames: the same picture (hash) is kept once; descriptions are cut; a failed grab adds nothing", () => {
  let game = liveGame(ON, ledger(), 10);
  ({ game } = grab(game, T0, "a", "x".repeat(FRAME_NOTE_MAX + 50)));
  const again = grab(game, T0 + FRAME_GAP_MS, "a", "the same picture");
  assert.deepEqual(again.game.live[0].frames!.map((f) => [f.hash, f.text?.length]), [["a", FRAME_NOTE_MAX]]);
  game = again.game;
  const claim = startAi(game, T0 + 2 * FRAME_GAP_MS, ON);
  const failed = applyFrame(claim.game, claim.captures[0], null, T0 + 2 * FRAME_GAP_MS);
  assert.equal(failed.game.live[0].frames!.length, 1);
  assert.equal(failed.game.live[0].grabAt, T0 + 2 * FRAME_GAP_MS, "the claim stands: the next grab waits for the gap");
});

test(`frames: at most ${MAX_FRAME_NOTES} notes; the first and the newest stay, in time order`, () => {
  let game = liveGame(ON, ledger(), 30);
  for (let i = 0; i < MAX_FRAME_NOTES + 5; i++) ({ game } = grab(game, T0 + i * FRAME_GAP_MS, `h${i}`));
  const hashes = game.live[0].frames!.map((f) => f.hash);
  assert.equal(hashes.length, MAX_FRAME_NOTES);
  assert.deepEqual(hashes, ["h0", ...Array.from({ length: MAX_FRAME_NOTES - 1 }, (_, i) => `h${i + 6}`)]);
});

test("frames: a grab that lands after the prediction was resolved goes to its check; checks carry the frames and the rule", () => {
  let game = liveGame(ON);
  ({ game } = grab(game, T0, "a", "A person at a desk"));
  const late = startAi(game, T0 + MIN, ON);
  assert.equal(late.captures.length, 1);
  game = resolveYes(late.game, ON, T0 + MIN);
  game = applyFrame(game, late.captures[0], { hash: "b", text: "The streamer jumps" }, T0 + MIN).game;
  assert.deepEqual(game.resolved[0].check?.frames.map((f) => [f.kind, f.hash]), [["launch", "a"], ["after", "b"]]);
  const checks = startAi(game, T0 + MIN, ON).checks;
  assert.deepEqual(checks.map((c) => [c.outcome, c.rule, c.frames.length, c.tries]), [["yes", "YES if the streamer is seen in the air", 2, 1]]);
});

test("an admin's YES/NO starts a check; cancel and coins without the AI get none", () => {
  const game = resolveYes(liveGame(ON), ON);
  assert.deepEqual(game.resolved[0].check, { tries: 0, at: T0 + MIN, frames: [], rule: "YES if the streamer is seen in the air" });
  const claim = startAi(game, T0 + MIN, ON);
  assert.deepEqual(claim.checks.map((c) => [c.outcome, c.tries]), [["yes", 1]]);
  assert.equal(aiDue(claim.game, T0 + MIN + 1, ON), false, "a claimed run isn't started twice");

  const live = liveGame(ON);
  const cancelled = apply(live, { kind: "resolve", id: live.live[0].id, outcome: "cancel" }, actor(ORACLE), T0 + MIN, ON).game;
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

test("failed check runs give their lease back and retry after a pause, at most twice; then the result shows couldn't tell", () => {
  let game = resolveYes(liveGame(ON), ON);
  const id = game.resolved[0].id;
  let t = T0 + MIN;
  for (let run = 1; run <= AI_CHECK_MAX_TRIES; run++) {
    const claim = startAi(game, t, ON);
    assert.deepEqual(claim.checks.map((c) => c.tries), [run]);
    game = claim.game;
    assert.equal(startAi(game, t + AI_RUN_LEASE_MS - 1, ON).checks.length, 0, "a running check holds its lease");
    game = releaseAiRun(game, id, run, t + 1_000).game; // it failed
    assert.equal(startAi(game, t + 1_000 + AI_CHECK_RETRY_MS - 1, ON).checks.length, 0, "not before the pause");
    t += 1_000 + AI_CHECK_RETRY_MS;
  }
  assert.equal(startAi(game, t, ON).checks.length, 0, "no fourth run");
  game = apply(game, { kind: "tick" }, null, t).game;
  assert.deepEqual([game.resolved[0].check, game.resolved[0].ai?.verdict, game.resolved[0].disputed], [undefined, "unclear", false]);
});

test("audit 7: the last check run is never written off while it holds its lease; its late verdict still counts; a stale one doesn't", () => {
  let game = resolveYes(liveGame(ON), ON);
  const id = game.resolved[0].id;
  let t = T0 + MIN;
  for (let run = 1; run < AI_CHECK_MAX_TRIES; run++) {
    game = releaseAiRun(startAi(game, t, ON).game, id, run, t).game;
    t += AI_CHECK_RETRY_MS;
  }
  game = startAi(game, t, ON).game; // the last run, slow
  game = apply(game, { kind: "tick" }, null, t + AI_RUN_LEASE_MS - 1).game;
  assert.ok(game.resolved[0].check, "still running: not written off");
  assert.equal(applyAiVerdict(game, id, "disagree", t + 100_000, ON, 1).changed, false, "an older run's verdict is ignored");
  assert.equal(releaseAiRun(game, id, 1, t + 100_000).changed, false, "an older run can't give the lease back");
  game = applyAiVerdict(game, id, "agree", t + 100_000, ON, AI_CHECK_MAX_TRIES).game;
  assert.equal(game.resolved[0].ai?.verdict, "agree");
});

test("audit 5: an AI disagree stays a dispute when a later flag is below the threshold; the result never counts", () => {
  const l = ledger();
  let game = l.take(resolveYesResult(liveGame(ON, l), ON));
  const id = game.resolved[0].id;
  game = l.take(applyAiVerdict(game, id, "disagree", T0 + MIN + 1_000));
  game = l.take(apply(game, { kind: "flag", id }, actor("b1"), T0 + MIN + 2_000, ON));
  assert.deepEqual([game.resolved[0].flags, game.resolved[0].bettors, game.resolved[0].disputed], [1, 6, true], "1 flag of 6 doesn't clear it");
  game = l.take(apply(game, { kind: "tick" }, null, T0 + MIN + FLAG_WINDOW_MS));
  assert.deepEqual([game.resolved[0].askerReward, l.won.size], [0, 0]);
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
