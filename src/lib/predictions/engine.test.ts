import assert from "node:assert/strict";
import { test } from "node:test";
import { type Action, type Actor, apply, applyReview, type Game, GameError, newGame, type Result, STAFF, startReviews } from "./engine";
import { FLAG_WINDOW_MS, MAX_BETTORS, MAX_HISTORY, MAX_PREDICTIONS_PER_STREAM, MAX_QUEUE, MAX_UPVOTERS_STORED, NOTICE_MS, REVIEW_MAX_TRIES, REVIEW_RETRY_MS } from "./rules";

const MIN = 60_000;
const T0 = 1_000_000_000;
const STREAMER = "Streamer";
const MOD = "Mod";

/**
 * A tiny world: one coin's game plus every wallet's balance, so tests can check the point
 * movements the engine asks for (the store applies them for real; see store.test.ts).
 * Everyone holds the coin unless listed in `nonHolders`; the streamer is watching unless `away()`.
 */
function world(balances: Record<string, number> = {}, eligible: string[] = [], nonHolders: string[] = [], { reviewed = true } = {}) {
  let game: Game = newGame(STREAMER);
  const bal = new Map(Object.entries(balances));
  const eligibleSet = new Set(eligible);
  let streamerHere = true;
  const actor = (wallet: string): Actor => ({ wallet, eligible: eligibleSet.has(wallet), holder: !nonHolders.includes(wallet), balance: bal.get(wallet) ?? 0 });
  const env = (now: number) => ({ streamerSeenAt: streamerHere ? now - MIN : null });
  const settle = (result: Result) => {
    for (const [w, m] of result.moves) {
      const before = bal.get(w) ?? 0;
      assert.ok(before >= m.floor && before + m.delta >= 0, `${w} can afford the move`);
      bal.set(w, before + m.delta);
    }
    game = result.game;
    return result;
  };
  /** The AI review's verdict on question `id` (a suggestion or the staff launch). */
  const review = (id: string, verdict: Parameters<typeof applyReview>[2], now: number) => {
    const item = [...game.suggestions, ...(game.pending ? [game.pending] : [])].find((x) => x.id === id)!;
    return settle(applyReview(game, { id, text: item.text }, verdict, now, env(now)));
  };
  /** Runs an action; unless `reviewed` is off, a typed question is approved at once, as if the review said yes. */
  const run = (action: Action, wallet: string | null, now: number) => {
    const result = settle(apply(game, action, wallet ? actor(wallet) : null, now, env(now)));
    const typed = action.kind === "suggest" || (action.kind === "launch" && action.text !== undefined);
    if (!reviewed || !typed) return result;
    const id = action.kind === "suggest" ? game.suggestions.find((x) => x.asker === wallet && x.review)?.id : game.pending?.id;
    return id ? review(id, { approved: true }, now) : result;
  };
  return {
    run,
    review,
    actor,
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
  refused(() => w.run({ kind: "suggest", text: "Will I eat a banana?" }, "outsider", T0), /Hold at least 1 of this coin/);
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "a", T0);
  assert.equal(w.bal.get("a"), 90);
  refused(() => w.run({ kind: "suggest", text: "Will I eat two bananas?" }, "a", T0 + 1), /already have a suggestion/);
  refused(() => w.run({ kind: "suggest", text: "Will it rain on stream?" }, "poor", T0), /costs 10 points/);
  refused(() => w.run({ kind: "suggest", text: "Hi?" }, "c", T0), /5 to 80/);
});

test("suggest: the queue holds at most MAX_QUEUE; the oldest expire first and free room", () => {
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
  refused(() => w.run({ kind: "upvote", id: "1" }, "outsider", T0), /Hold at least 1 of this coin/);
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

test("a new stream (the streamer back after 2+ hours away) resets the 20 and the stream leaderboard, not past results", () => {
  const w = world({ a: 1_000, b: 1_000 });
  w.game.stream = T0; // this stream started at T0
  let t = T0;
  for (let i = 0; i < MAX_PREDICTIONS_PER_STREAM; i++) {
    w.run({ kind: "launch", text: `Question number ${i}?`, windowMin: 1 }, STREAMER, t);
    w.run({ kind: "bet", side: "yes", amount: 10 }, "a", t);
    w.run({ kind: "bet", side: "no", amount: 10 }, "b", t);
    t += MIN;
    w.run({ kind: "resolve", outcome: "yes" }, STREAMER, t);
  }
  t += FLAG_WINDOW_MS;
  w.run({ kind: "tick" }, null, t);
  assert.deepEqual([w.game.launched, w.game.won], [20, { a: 200, b: -200 }]);
  const stream1 = { streamerSeenAt: t, streamStartedAt: T0 };
  let game = w.game;
  assert.equal(apply(game, { kind: "tick" }, null, t, stream1).changed, false, "same stream: nothing resets");
  refused(() => apply(game, { kind: "launch", text: "One more question?" }, w.actor(STREAMER), t, stream1), /20 predictions/);

  const stream2 = { streamerSeenAt: t + 3 * 60 * MIN, streamStartedAt: t + 3 * 60 * MIN };
  game = apply(game, { kind: "launch", text: "One more question?" }, w.actor(STREAMER), t + 3 * 60 * MIN, stream2).game;
  game = applyReview(game, game.pending!, { approved: true }, t + 3 * 60 * MIN, stream2).game; // the review says yes
  assert.deepEqual([game.launched, game.won, game.stream], [1, {}, stream2.streamStartedAt]);
  assert.equal(game.resolved.length, MAX_HISTORY, "past results stay");
  assert.equal(apply(game, { kind: "tick" }, null, t + 3 * 60 * MIN + 1, stream2).game.launched, 1, "one reset per stream");
});

test("a wallet with a stake can't resolve it, and can't be made a mod while its bet is live", () => {
  const w = world({ a: 1_000, b: 1_000 });
  w.run({ kind: "launch", text: "Will I eat a banana?", windowMin: 1 }, STREAMER, T0);
  w.run({ kind: "bet", side: "yes", amount: 100 }, "a", T0);
  w.run({ kind: "bet", side: "no", amount: 100 }, "b", T0);
  refused(() => w.run({ kind: "mod", wallet: "a", add: true }, STREAMER, T0), /has a bet on the live prediction/);
  // A bettor who became a mod before the bet (staff can't bet, so only through stored state).
  w.run({ kind: "mod", wallet: MOD, add: true }, STREAMER, T0);
  const staked = structuredClone(w.game);
  staked.live!.bets[MOD] = { side: "yes", amount: 100, eligible: false };
  refused(() => apply(staked, { kind: "resolve", outcome: "yes" }, w.actor(MOD), T0 + MIN), /can't resolve/);
  w.run({ kind: "resolve", outcome: "yes" }, MOD, T0 + MIN);
  w.run({ kind: "mod", wallet: "a", add: true }, STREAMER, T0 + MIN);
  assert.deepEqual(w.game.mods, [MOD, "a"], "once settled, the bettor can be a mod");
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

test("bets: at most MAX_BETTORS bettors per prediction; those in can still add", () => {
  const w = world({ late: 100, first: 100 });
  w.run({ kind: "launch", text: "Will I eat a banana?", windowMin: 5 }, STREAMER, T0);
  w.run({ kind: "bet", side: "yes", amount: 10 }, "first", T0);
  // Fill the rest straight into the state (that many real wallets would only slow the test down).
  const full = structuredClone(w.game);
  for (let i = 1; i < MAX_BETTORS; i++) full.live!.bets[`w${i}`] = { side: "no", amount: 10, eligible: false };
  full.live!.bettors = MAX_BETTORS;
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

test("results fold into summaries once their flag window closes; only the last 20 are kept", () => {
  const bettors = ["a", "b"];
  const w = world(Object.fromEntries(bettors.map((b) => [b, 1_000])));
  w.away();
  let t = T0;
  for (let i = 0; i < MAX_PREDICTIONS_PER_STREAM; i++) {
    w.run({ kind: "launch", text: `Question number ${i}?`, windowMin: 1 }, STREAMER, t);
    w.run({ kind: "bet", side: "yes", amount: 10 }, "a", t);
    w.run({ kind: "bet", side: "no", amount: 10 }, "b", t);
    t += MIN;
    w.run({ kind: "resolve", outcome: "yes" }, STREAMER, t);
  }
  const newest = w.game.resolved[0];
  assert.deepEqual(newest.open, { results: { a: [10, 20, 0], b: [10, 0, 0] }, eligible: 0 }, "the flag window needs who bet and what they got");
  w.run({ kind: "flag", id: newest.id }, "b", t);
  w.run({ kind: "tick" }, null, t + FLAG_WINDOW_MS);
  assert.equal(w.game.resolved.length, MAX_HISTORY);
  assert.ok(w.game.resolved.every((p) => p.open === null));
  assert.deepEqual(
    { ...w.game.resolved[0] },
    { id: newest.id, text: "Question number 19?", asker: null, outcome: "yes", yes: 10, no: 10, bettors: 2, resolvedAt: t, resolvedBy: STREAMER, askerReward: 0, flags: 1, disputed: true, open: null },
  );
});

test("the stream leaderboard keeps the top 100 only", () => {
  const w = world();
  const game = w.game;
  for (let i = 0; i < 150; i++) game.won[`w${String(i).padStart(3, "0")}`] = i;
  // One more result to finalize trims the map.
  game.resolved.unshift({
    id: "1", text: "Q?", asker: null, outcome: "yes", yes: 10, no: 10, bettors: 2, resolvedAt: T0, resolvedBy: STREAMER,
    askerReward: 0, flags: 0, disputed: false, open: { results: { x: [10, 20, 0], y: [10, 0, 0] }, eligible: 0 },
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

// ---------------------------------------------------------------------------------------------
// AI review: typed questions wait "under review" until the review approves them.
// ---------------------------------------------------------------------------------------------

const SEC = 1_000;

test("review: a suggestion under review can't be upvoted, launched or crowd-picked; approval queues it", () => {
  const w = world({ asker: 100 }, ["v0", "v1", "v2"], [], { reviewed: false });
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "asker", T0);
  assert.deepEqual(w.game.suggestions[0].review, { tries: 0, at: T0 });
  assert.equal(w.bal.get("asker"), 90);
  refused(() => w.run({ kind: "upvote", id: "1" }, "v0", T0), /gone/);
  refused(() => w.run({ kind: "launch", id: "1" }, STREAMER, T0), /gone/);
  refused(() => w.run({ kind: "suggest", text: "Will I eat two bananas?" }, "asker", T0), /already have a suggestion/);
  w.review("1", { approved: true }, T0 + SEC);
  assert.equal(w.game.suggestions[0].review, undefined);
  for (const v of ["v0", "v1", "v2"]) w.run({ kind: "upvote", id: "1" }, v, T0 + 2 * SEC);
  assert.equal(w.game.live?.text, "Will I eat a banana?", "approved, upvoted, crowd-launched");
});

test("review: a rejected suggestion leaves, its 10 points stay spent, and its asker sees why and waits 5 minutes", () => {
  const w = world({ asker: 100 }, [], [], { reviewed: false });
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "asker", T0);
  w.review("1", { approved: false, text: "Not approved: spam or ads" }, T0 + SEC);
  assert.deepEqual([w.game.suggestions.length, w.bal.get("asker")], [0, 90], "rejected spam is never free");
  assert.deepEqual(w.game.notices, [{ to: "asker", text: "Not approved: spam or ads", until: T0 + SEC + NOTICE_MS }]);
  refused(() => w.run({ kind: "suggest", text: "Will I eat an apple?" }, "asker", T0 + 2 * SEC), /wasn't approved/);
  w.run({ kind: "tick" }, null, T0 + SEC + NOTICE_MS);
  assert.deepEqual(w.game.notices, []);
  w.run({ kind: "suggest", text: "Will I eat an apple?" }, "asker", T0 + SEC + NOTICE_MS);
  assert.equal(w.game.suggestions.length, 1, "after the wait the asker can suggest again");
  // A verdict on a question that changed or left meanwhile does nothing.
  assert.equal(applyReview(w.game, { id: "1", text: "Will I eat a banana?" }, { approved: false, text: "x" }, T0 + 3 * SEC).changed, false);
});

test("review: a typed staff question goes live only on approval (its window starts then); a rejection uses no launch", () => {
  const w = world({ a: 100 }, [], [], { reviewed: false });
  w.run({ kind: "launch", text: "Will chat hit 100?", windowMin: 2 }, STREAMER, T0);
  assert.ok(w.game.live === null, "not live yet");
  assert.equal(w.game.pending?.text, "Will chat hit 100?");
  refused(() => w.run({ kind: "bet", side: "yes", amount: 10 }, "a", T0), /Betting is closed/);
  refused(() => w.run({ kind: "launch", text: "Another one here?" }, STREAMER, T0), /under review/);
  w.review(w.game.pending!.id, { approved: false, text: "Not approved: violent" }, T0 + SEC);
  assert.deepEqual([w.game.pending, w.game.launched, w.game.notices[0].to], [null, 0, STAFF]);

  w.run({ kind: "launch", text: "Will chat hit 200?", windowMin: 2 }, STREAMER, T0 + 2 * SEC);
  w.review(w.game.pending!.id, { approved: true }, T0 + 5 * SEC);
  const live = w.game.live as Game["live"]; // (assert.ok above narrowed it to null)
  const launched = w.game.launched;
  assert.deepEqual([live?.text, live?.launchedAt, live?.lockAt, launched], ["Will chat hit 200?", T0 + 5 * SEC, T0 + 5 * SEC + 2 * MIN, 1]);
});

test("review: checks start at once, then at most every 5 s, at most 5 times; then staff decide by hand", () => {
  const w = world({ asker: 100 }, [], [], { reviewed: false });
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "asker", T0);
  let t = T0;
  const start = () => {
    const r = startReviews(w.game, t);
    w.run({ kind: "tick" }, null, t);
    Object.assign(w.game, r.game);
    return r.due.map((d) => d.id);
  };
  assert.deepEqual(start(), ["1"]);
  assert.deepEqual(start(), [], "already started");
  t += REVIEW_RETRY_MS - 1;
  assert.deepEqual(start(), [], "too soon");
  refused(() => w.run({ kind: "approve", id: "1" }, STREAMER, t), /still being checked/);
  for (let i = 2; i <= REVIEW_MAX_TRIES; i++) {
    t += REVIEW_RETRY_MS;
    assert.deepEqual(start(), ["1"], `try ${i}`);
  }
  t += REVIEW_RETRY_MS;
  assert.deepEqual(start(), [], "no tries left");
  refused(() => w.run({ kind: "approve", id: "1" }, "asker", t), /Only the streamer/);
  w.run({ kind: "approve", id: "1" }, STREAMER, t);
  assert.equal(w.game.suggestions[0].review, undefined);
});

test("review: staff remove a stuck question by hand: the asker is refunded and told; stuck staff questions too", () => {
  const w = world({ asker: 100 }, [], [], { reviewed: false });
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "asker", T0);
  w.run({ kind: "launch", text: "Will chat hit 100?" }, STREAMER, T0);
  w.game.suggestions[0].review = { tries: REVIEW_MAX_TRIES, at: T0 };
  w.game.pending!.review = { tries: REVIEW_MAX_TRIES, at: T0 };
  w.run({ kind: "remove", id: "1" }, STREAMER, T0 + SEC);
  assert.deepEqual([w.game.suggestions.length, w.bal.get("asker"), w.game.notices[0].to], [0, 100, "asker"]);
  w.run({ kind: "approve", id: w.game.pending!.id }, STREAMER, T0 + 2 * SEC);
  assert.equal(w.game.live?.text, "Will chat hit 100?");
});

test("review: a suggestion still under review after 20 minutes expires and its points come back", () => {
  const w = world({ asker: 100 }, [], [], { reviewed: false });
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "asker", T0);
  w.run({ kind: "launch", text: "Will chat hit 100?" }, STREAMER, T0);
  w.run({ kind: "tick" }, null, T0 + 20 * MIN);
  assert.deepEqual([w.game.suggestions.length, w.game.pending, w.bal.get("asker")], [0, null, 100]);
});
