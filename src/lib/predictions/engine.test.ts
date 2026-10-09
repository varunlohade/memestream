import assert from "node:assert/strict";
import { test } from "node:test";
import { type Action, type Actor, apply, type Game, GameError, newGame } from "./engine";
import { FLAG_WINDOW_MS, MAX_QUEUE, MAX_UPVOTERS_STORED } from "./rules";

const MIN = 60_000;
const T0 = 1_000_000_000;
const STREAMER = "Streamer";
const MOD = "Mod";

/**
 * A tiny world: one coin's game plus every wallet's balance, so tests can check the point
 * movements the engine asks for (the store applies them for real; see store.test.ts).
 * Everyone holds the coin unless listed in `nonHolders`; the streamer is watching unless `away()`.
 */
function world(balances: Record<string, number> = {}, eligible: string[] = [], nonHolders: string[] = []) {
  let game: Game = newGame(STREAMER);
  const bal = new Map(Object.entries(balances));
  const eligibleSet = new Set(eligible);
  let streamerHere = true;
  const actor = (wallet: string): Actor => ({ wallet, eligible: eligibleSet.has(wallet), holder: !nonHolders.includes(wallet), balance: bal.get(wallet) ?? 0 });
  const run = (action: Action, wallet: string | null, now: number) => {
    const result = apply(game, action, wallet ? actor(wallet) : null, now, { streamerSeenAt: streamerHere ? now - MIN : null });
    for (const [w, m] of result.moves) {
      const before = bal.get(w) ?? 0;
      assert.ok(before >= m.floor && before + m.delta >= 0, `${w} can afford the move`);
      bal.set(w, before + m.delta);
    }
    game = result.game;
    return result;
  };
  return {
    run,
    bal,
    get game() {
      return game;
    },
    eligible: (w: string) => eligibleSet.add(w),
    away: (gone = true) => {
      streamerHere = !gone;
    },
  };
}

const refused = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && pattern.test(e.message));

/** A world with a suggestion "1" by `asker` and `up` eligible upvoters. */
function withSuggestion(up: number, extra: Record<string, number> = {}) {
  const voters = Array.from({ length: up }, (_, i) => `v${i}`);
  const w = world({ asker: 100, ...extra }, voters);
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "asker", T0);
  for (const v of voters) w.run({ kind: "upvote", id: "1" }, v, T0 + MIN);
  return w;
}

test("suggest: holders only; costs 10 points, one open suggestion per wallet per coin", () => {
  const w = world({ a: 100, c: 100, poor: 9, outsider: 100 }, [], ["outsider"]);
  refused(() => w.run({ kind: "suggest", text: "Will I eat a banana?" }, "outsider", T0), /Hold this coin/);
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "a", T0);
  assert.equal(w.bal.get("a"), 90);
  refused(() => w.run({ kind: "suggest", text: "Will I eat two bananas?" }, "a", T0 + 1), /already have a suggestion/);
  refused(() => w.run({ kind: "suggest", text: "Will it rain on stream?" }, "poor", T0), /costs 10 points/);
  refused(() => w.run({ kind: "suggest", text: "Hi?" }, "c", T0), /5 to 80/);
});

test("suggest: the queue holds at most 50; the oldest expire first and free room", () => {
  const askers = Array.from({ length: MAX_QUEUE + 1 }, (_, i) => `a${i}`);
  const w = world(Object.fromEntries(askers.map((a) => [a, 100])));
  w.away(); // nothing auto-launches
  for (const [i, a] of askers.slice(0, MAX_QUEUE).entries()) w.run({ kind: "suggest", text: `Question number ${i}?` }, a, T0 + i * 1_000);
  refused(() => w.run({ kind: "suggest", text: "One too many here?" }, askers[MAX_QUEUE], T0 + 60_000), /queue is full/);
  // 20 minutes after the first one, it expires and there is room again.
  w.run({ kind: "suggest", text: "One too many here?" }, askers[MAX_QUEUE], T0 + 20 * MIN);
  assert.equal(w.game.suggestions.length, MAX_QUEUE);
  assert.equal(w.game.suggestions[0].asker, "a1");
});

test("suggest: the 10 points come back when it goes live; expiry after 20 minutes keeps them", () => {
  const live = withSuggestion(3);
  assert.equal(live.game.live?.id, "1", "3 upvotes: live at once");
  assert.equal(live.bal.get("asker"), 100);

  const expired = withSuggestion(2);
  expired.run({ kind: "tick" }, null, T0 + 20 * MIN - 1);
  assert.equal(expired.game.suggestions.length, 1);
  expired.run({ kind: "tick" }, null, T0 + 20 * MIN);
  assert.equal(expired.game.suggestions.length, 0);
  assert.equal(expired.bal.get("asker"), 90, "spent");
  expired.run({ kind: "suggest", text: "Will chat win this round?" }, "asker", T0 + 21 * MIN);
});

test("upvote: free; holders with 15 minutes watched only; once each, never your own", () => {
  const w = world({ a: 100 }, ["a", "b", "outsider"], ["outsider"]);
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "a", T0);
  refused(() => w.run({ kind: "upvote", id: "1" }, "outsider", T0), /Hold this coin/);
  refused(() => w.run({ kind: "upvote", id: "1" }, "newcomer", T0), /Watch 15 minutes/);
  refused(() => w.run({ kind: "upvote", id: "1" }, "a", T0), /your own/);
  w.run({ kind: "upvote", id: "1" }, "b", T0);
  refused(() => w.run({ kind: "upvote", id: "1" }, "b", T0), /already upvoted/);
  assert.deepEqual([w.game.suggestions[0].upvoters, w.game.suggestions[0].upvotes], [["b"], 1]);
  assert.equal(w.bal.get("b") ?? 0, 0, "upvotes cost nothing");
  refused(() => w.run({ kind: "upvote", id: "9" }, "b", T0), /gone/);
});

test("upvote: beyond 200 stored upvoters only a fingerprint and the count are kept; dedupe still works", () => {
  const voters = Array.from({ length: MAX_UPVOTERS_STORED + 5 }, (_, i) => `voter${String(i).padStart(5, "0")}xyz`);
  const w = world({ a: 100 }, voters);
  w.away();
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "a", T0);
  for (const v of voters) w.run({ kind: "upvote", id: "1" }, v, T0);
  const s = w.game.suggestions[0];
  assert.deepEqual([s.upvoters.length, s.extra.length, s.upvotes], [MAX_UPVOTERS_STORED, 5, MAX_UPVOTERS_STORED + 5]);
  assert.ok(s.extra.every((print) => print.length === 10));
  refused(() => w.run({ kind: "upvote", id: "1" }, voters.at(-1)!, T0), /already upvoted/);
  refused(() => w.run({ kind: "upvote", id: "1" }, voters[0], T0), /already upvoted/);
});

test("auto-launch: needs 3 upvotes; picks the most upvoted, then the oldest; one live at a time", () => {
  const voters = ["e1", "e2", "e3", "e4", "e5", "e6", "e7"];
  const w = world({ a: 100, b: 100, c: 100 }, voters);
  w.run({ kind: "launch", text: "Streamer's warm-up question?" }, STREAMER, T0); // keeps the slot busy
  w.run({ kind: "suggest", text: "Question from A here?" }, "a", T0);
  w.run({ kind: "suggest", text: "Question from B here?" }, "b", T0 + 1);
  w.run({ kind: "suggest", text: "Question from C here?" }, "c", T0 + 2);
  for (const v of voters.slice(0, 3)) w.run({ kind: "upvote", id: "2" }, v, T0 + 3); // A: 3
  for (const v of voters.slice(0, 4)) w.run({ kind: "upvote", id: "3" }, v, T0 + 3); // B: 4
  for (const v of voters.slice(0, 4)) w.run({ kind: "upvote", id: "4" }, v, T0 + 3); // C: 4, but newer
  assert.equal(w.game.live?.id, "1", "nothing auto-launches while one is live");
  w.run({ kind: "resolve", outcome: "cancel" }, STREAMER, T0 + 2 * MIN);
  assert.equal(w.game.live?.text, "Question from B here?", "most upvotes, then oldest");
  assert.equal(w.game.live?.launchedBy, "crowd");
  assert.equal(w.game.live!.lockAt - w.game.live!.launchedAt, 2 * MIN, "default 2-minute window");
});

test("auto-launch: only while the streamer is here (heartbeat in the last 5 minutes) and crowd picks are on", () => {
  const w = withSuggestion(0, {});
  for (const v of ["v0", "v1", "v2"]) w.eligible(v);
  w.away();
  for (const v of ["v0", "v1", "v2"]) w.run({ kind: "upvote", id: "1" }, v, T0 + MIN);
  assert.equal(w.game.live, null, "streamer away: it waits in the queue");
  w.run({ kind: "crowd", on: false }, STREAMER, T0 + 2 * MIN);
  w.away(false);
  w.run({ kind: "tick" }, null, T0 + 2 * MIN);
  assert.equal(w.game.live, null, "streamer back, but crowd picks off");
  refused(() => w.run({ kind: "crowd", on: true }, "v0", T0 + 2 * MIN), /streamer or a mod/);
  w.run({ kind: "crowd", on: true }, STREAMER, T0 + 3 * MIN);
  assert.equal((w.game as Game).live?.id, "1", "streamer back, crowd picks on");

  // Exactly 5 minutes since the streamer's last heartbeat counts as away.
  const late = apply(newGame(STREAMER), { kind: "tick" }, null, T0, { streamerSeenAt: T0 - 5 * MIN });
  assert.equal(late.changed, false);
});

test("caps: 20 predictions per stream; then no launches and no suggestions", () => {
  const w = world({ a: 100 });
  for (let i = 0; i < 20; i++) {
    const t = T0 + i * 10 * MIN;
    w.run({ kind: "launch", text: `Question number ${i}?`, windowMin: 1 }, STREAMER, t);
    w.run({ kind: "resolve", outcome: "cancel" }, STREAMER, t + MIN);
  }
  assert.equal(w.game.launched, 20);
  refused(() => w.run({ kind: "launch", text: "One more question?" }, STREAMER, T0 + 300 * MIN), /20 predictions/);
  refused(() => w.run({ kind: "suggest", text: "One more question?" }, "a", T0 + 300 * MIN), /20 predictions/);
  refused(() => world().run({ kind: "launch", text: "Bad window here?", windowMin: 3 }, STREAMER, T0), /1, 2, 5 or 10/);
});

test("bets: 10 to 1,000 points, at most half the balance, add to your side but never switch", () => {
  const w = world({ a: 3_000, b: 50 });
  w.run({ kind: "launch", text: "Will I eat a banana?", windowMin: 5 }, STREAMER, T0);
  refused(() => w.run({ kind: "bet", side: "yes", amount: 9 }, "a", T0), /10 to 1000/);
  refused(() => w.run({ kind: "bet", side: "yes", amount: 1_001 }, "a", T0), /10 to 1000/);
  refused(() => w.run({ kind: "bet", side: "yes", amount: 10.5 }, "a", T0), /10 to 1000/);
  refused(() => w.run({ kind: "bet", side: "no", amount: 26 }, "b", T0), /half your points/);
  w.run({ kind: "bet", side: "no", amount: 25 }, "b", T0);
  w.run({ kind: "bet", side: "yes", amount: 600 }, "a", T0);
  refused(() => w.run({ kind: "bet", side: "no", amount: 10 }, "a", T0), /not switch/);
  refused(() => w.run({ kind: "bet", side: "yes", amount: 401 }, "a", T0), /At most 1000/);
  w.run({ kind: "bet", side: "yes", amount: 400 }, "a", T0);
  assert.deepEqual(w.game.live!.bets.a, { side: "yes", amount: 1_000, eligible: false });
  assert.deepEqual([w.game.live!.yes, w.game.live!.no], [1_000, 25]);
  assert.equal(w.bal.get("a"), 2_000);
  refused(() => w.run({ kind: "bet", side: "no", amount: 10 }, "b", T0 + 5 * MIN), /closed/);
});

test("bets: at most 1,000 bettors per prediction; those in can still add", () => {
  const w = world({ late: 100, first: 100 });
  w.run({ kind: "launch", text: "Will I eat a banana?", windowMin: 5 }, STREAMER, T0);
  w.run({ kind: "bet", side: "yes", amount: 10 }, "first", T0);
  // Fill the rest straight into the state (1,000 real wallets would only slow the test down).
  const full = structuredClone(w.game);
  for (let i = 1; i < 1_000; i++) full.live!.bets[`w${i}`] = { side: "no", amount: 10, eligible: false };
  full.live!.bettors = 1_000;
  const actor = (wallet: string): Actor => ({ wallet, eligible: false, holder: true, balance: 100 });
  refused(() => apply(full, { kind: "bet", side: "yes", amount: 10 }, actor("late"), T0), /is full/);
  assert.equal(apply(full, { kind: "bet", side: "yes", amount: 10 }, actor("first"), T0).game.live!.bets.first.amount, 20);
});

test("resolve: after lock only, by the streamer or a mod; winners split the pool; points conserved", () => {
  const w = world({ a: 1_000, b: 1_000, c: 1_000 });
  w.run({ kind: "mod", wallet: MOD, add: true }, STREAMER, T0);
  w.run({ kind: "launch", text: "Will I eat a banana?", windowMin: 1 }, STREAMER, T0);
  w.run({ kind: "bet", side: "yes", amount: 100 }, "a", T0);
  w.run({ kind: "bet", side: "yes", amount: 300 }, "b", T0);
  w.run({ kind: "bet", side: "no", amount: 400 }, "c", T0);
  refused(() => w.run({ kind: "resolve", outcome: "yes" }, MOD, T0 + MIN - 1), /still open/);
  refused(() => w.run({ kind: "resolve", outcome: "yes" }, "a", T0 + MIN), /streamer or a mod/);
  w.run({ kind: "resolve", outcome: "yes" }, MOD, T0 + MIN);
  assert.deepEqual([w.bal.get("a"), w.bal.get("b"), w.bal.get("c")], [1_100, 1_300, 600], "paid at once");
  const total = [...w.bal.values()].reduce((x, y) => x + y, 0);
  assert.equal(total, 3_000, "parimutuel moves points, never makes them");
  const done = w.game.resolved[0];
  assert.deepEqual([done.outcome, done.resolvedBy, done.resolvedAt], ["yes", MOD, T0 + MIN]);
  assert.deepEqual(w.game.won, {}, "winnings count only after the flag window");
  const after = w.run({ kind: "tick" }, null, T0 + MIN + FLAG_WINDOW_MS);
  assert.deepEqual(w.game.won, { a: 100, b: 300, c: -400 });
  assert.deepEqual(Object.fromEntries(after.won), { a: 100, b: 300, c: -400 }, "all-time winnings move too");
  refused(() => w.run({ kind: "resolve", outcome: "no" }, MOD, T0 + MIN), /Nothing to resolve/);
});

test("resolve: an empty side or a cancel refunds every bet", () => {
  for (const [bets, outcome] of [[["yes", "yes"], "no"], [["yes", "no"], "cancel"]] as const) {
    const w = world({ a: 1_000, b: 1_000 });
    w.run({ kind: "launch", text: "Will I eat a banana?", windowMin: 1 }, STREAMER, T0);
    w.run({ kind: "bet", side: bets[0], amount: 100 }, "a", T0);
    w.run({ kind: "bet", side: bets[1], amount: 200 }, "b", T0);
    w.run({ kind: "resolve", outcome }, STREAMER, T0 + MIN);
    w.run({ kind: "tick" }, null, T0 + MIN + FLAG_WINDOW_MS);
    assert.deepEqual([w.bal.get("a"), w.bal.get("b")], [1_000, 1_000], `${bets} ${outcome}`);
    assert.deepEqual(w.game.won, {});
  }
});

test("auto-cancel: the streamer's own unresolved 60 minutes after lock; full refunds; then the next one goes live", () => {
  const w = world({ a: 1_000, asker: 100 }, ["v0", "v1", "v2"]);
  w.run({ kind: "launch", text: "Will I eat a banana?", windowMin: 1 }, STREAMER, T0);
  w.run({ kind: "bet", side: "yes", amount: 100 }, "a", T0);
  w.run({ kind: "suggest", text: "Is the next round a win?" }, "asker", T0 + 50 * MIN);
  for (const v of ["v0", "v1", "v2"]) w.run({ kind: "upvote", id: "2" }, v, T0 + 50 * MIN);
  w.run({ kind: "tick" }, null, T0 + 61 * MIN - 1);
  assert.equal(w.game.live?.id, "1", "still waiting for the streamer");
  w.run({ kind: "tick" }, null, T0 + 61 * MIN);
  assert.deepEqual([w.game.resolved[0].outcome, w.game.resolved[0].resolvedBy], ["cancel", "auto"]);
  assert.equal(w.bal.get("a"), 1_000);
  assert.equal(w.game.live?.id, "2", "the crowd's pick goes live next");
});

test("auto-cancel: a crowd-launched prediction cancels 15 minutes after lock", () => {
  const w = withSuggestion(3, { a: 1_000 });
  assert.equal(w.game.live?.launchedBy, "crowd");
  const lockAt = w.game.live!.lockAt;
  w.run({ kind: "bet", side: "yes", amount: 100 }, "a", T0 + MIN);
  w.run({ kind: "tick" }, null, lockAt + 15 * MIN - 1);
  assert.notEqual(w.game.live, null);
  w.run({ kind: "tick" }, null, lockAt + 15 * MIN);
  assert.deepEqual([w.game.resolved[0].outcome, w.game.resolved[0].resolvedBy], ["cancel", "auto"]);
  assert.equal(w.bal.get("a"), 1_000);
});

test("streamer and mods can't suggest, upvote or bet on their own coin; only the streamer manages mods", () => {
  const w = world({ [STREAMER]: 1_000, [MOD]: 1_000, a: 100 }, [STREAMER, MOD]);
  refused(() => w.run({ kind: "mod", wallet: "a", add: true }, MOD, T0), /Only the streamer/);
  w.run({ kind: "mod", wallet: MOD, add: true }, STREAMER, T0);
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "a", T0);
  for (const wallet of [STREAMER, MOD]) {
    refused(() => w.run({ kind: "suggest", text: "My own question here?" }, wallet, T0), /can't suggest/);
    refused(() => w.run({ kind: "upvote", id: "1" }, wallet, T0), /can't upvote/);
  }
  w.run({ kind: "launch", id: "1", windowMin: 10 }, MOD, T0);
  assert.equal(w.game.live?.launchedBy, MOD);
  for (const wallet of [STREAMER, MOD]) refused(() => w.run({ kind: "bet", side: "yes", amount: 10 }, wallet, T0), /can't bet/);
  refused(() => w.run({ kind: "remove", id: "1" }, "a", T0), /streamer or a mod/);
  w.run({ kind: "mod", wallet: MOD, add: false }, STREAMER, T0);
  refused(() => w.run({ kind: "resolve", outcome: "yes" }, MOD, T0 + 10 * MIN), /streamer or a mod/);
});

test("remove: the streamer drops a suggestion; its 10 points are spent", () => {
  const w = world({ a: 100 });
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "a", T0);
  w.run({ kind: "remove", id: "1" }, STREAMER, T0);
  assert.equal(w.game.suggestions.length, 0);
  assert.equal(w.bal.get("a"), 90);
});

/** A crowd question by "asker", 6 bettors (the first `eligibleBettors` eligible), resolved `outcome`, `flaggers` flag it. */
function askerScenario(eligibleBettors: number, outcome: "yes" | "cancel", flaggers = 0) {
  const bettors = ["b0", "b1", "b2", "b3", "b4", "b5"];
  const w = withSuggestion(3, Object.fromEntries(bettors.map((b) => [b, 1_000])));
  for (const [i, b] of bettors.entries()) {
    if (i < eligibleBettors) w.eligible(b);
    w.run({ kind: "bet", side: i % 2 ? "yes" : "no", amount: 20 }, b, T0 + MIN);
  }
  w.run({ kind: "resolve", outcome }, STREAMER, T0 + 3 * MIN);
  for (const b of bettors.slice(0, flaggers)) w.run({ kind: "flag", id: "1" }, b, T0 + 4 * MIN);
  const before = w.bal.get("asker");
  w.run({ kind: "tick" }, null, T0 + 3 * MIN + FLAG_WINDOW_MS);
  return { reward: w.game.resolved[0].askerReward, paid: w.bal.get("asker")! - before!, won: w.game.won };
}

test("asker reward: +50 only on YES/NO with at least 5 distinct eligible bettors, after the flag window", () => {
  assert.deepEqual(askerScenario(5, "yes").paid, 50);
  assert.equal(askerScenario(5, "yes").reward, 50);
  assert.equal(askerScenario(4, "yes").paid, 0);
  assert.equal(askerScenario(6, "cancel").paid, 0);
});

test("disputed results: no asker reward and no leaderboard winnings; bettors keep their payouts", () => {
  const disputed = askerScenario(6, "yes", 2); // 2 of 6 flags = 33%
  assert.deepEqual([disputed.paid, disputed.won], [0, {}]);
  const fine = askerScenario(6, "yes", 1); // 1 of 6 = 17%
  assert.equal(fine.paid, 50);
  assert.deepEqual(fine.won, { b1: 20, b3: 20, b5: 20, b0: -20, b2: -20, b4: -20 });
});

test("flags: bettors only, once each, within the flag window; disputed at 30% of bettors", () => {
  const bettors = Array.from({ length: 10 }, (_, i) => `b${i}`);
  const w = world(Object.fromEntries(bettors.map((b) => [b, 1_000])));
  w.run({ kind: "launch", text: "Will I eat a banana?", windowMin: 1 }, STREAMER, T0);
  for (const [i, b] of bettors.entries()) w.run({ kind: "bet", side: i < 5 ? "yes" : "no", amount: 10 }, b, T0);
  w.run({ kind: "resolve", outcome: "yes" }, STREAMER, T0 + MIN);
  refused(() => w.run({ kind: "flag", id: "1" }, "outsider", T0 + MIN), /Only its bettors/);
  w.run({ kind: "flag", id: "1" }, "b5", T0 + MIN);
  refused(() => w.run({ kind: "flag", id: "1" }, "b5", T0 + MIN), /already flagged/);
  w.run({ kind: "flag", id: "1" }, "b6", T0 + MIN);
  assert.equal(w.game.resolved[0].disputed, false, "2 of 10");
  w.run({ kind: "flag", id: "1" }, "b7", T0 + MIN);
  assert.equal(w.game.resolved[0].disputed, true, "3 of 10");
  refused(() => w.run({ kind: "flag", id: "1" }, "b8", T0 + MIN + FLAG_WINDOW_MS), /Too late/);
});

test("the stream leaderboard keeps the top 100 only", () => {
  const w = world();
  const game = w.game;
  for (let i = 0; i < 150; i++) game.won[`w${String(i).padStart(3, "0")}`] = i;
  // One more result to finalize trims the map.
  const bettors = { x: { side: "yes" as const, amount: 10, eligible: false }, y: { side: "no" as const, amount: 10, eligible: false } };
  game.resolved.unshift({
    id: "1", text: "Q?", asker: null, launchedAt: T0, lockAt: T0, launchedBy: STREAMER, bets: bettors, yes: 10, no: 10,
    outcome: "yes", resolvedAt: T0, resolvedBy: STREAMER, payouts: { x: 20, y: 0 }, askerReward: 0, flags: [], disputed: false, bettors: 2, finalized: false,
  });
  const result = apply(game, { kind: "tick" }, null, T0 + FLAG_WINDOW_MS);
  assert.equal(Object.keys(result.game.won).length, 100);
  assert.equal(result.game.won.w149, 149);
  assert.equal(result.game.won.w049, undefined);
});

test("a tick with nothing due changes nothing; actions need a signed-in wallet", () => {
  const w = world();
  assert.equal(w.run({ kind: "tick" }, null, T0).changed, false);
  refused(() => w.run({ kind: "upvote", id: "1" }, null, T0), /Sign in/);
});
