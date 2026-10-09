import assert from "node:assert/strict";
import { test } from "node:test";
import { type Action, type Actor, apply, type Game, GameError, newGame } from "./engine";

const MIN = 60_000;
const T0 = 1_000_000_000;
const STREAMER = "Streamer";
const MOD = "Mod";

/**
 * A tiny world: one coin's game plus every wallet's balance, so tests can check the point
 * movements the engine asks for (the store applies them for real; see store.test.ts).
 */
function world(balances: Record<string, number> = {}, eligible: string[] = []) {
  let game: Game = newGame(STREAMER);
  const bal = new Map(Object.entries(balances));
  const eligibleSet = new Set(eligible);
  const actor = (wallet: string): Actor => ({ wallet, eligible: eligibleSet.has(wallet), balance: bal.get(wallet) ?? 0 });
  const run = (action: Action, wallet: string | null, now: number) => {
    const result = apply(game, action, wallet ? actor(wallet) : null, now);
    for (const [w, m] of result.moves) {
      const before = bal.get(w) ?? 0;
      assert.ok(before >= m.floor && before + m.delta >= 0, `${w} can afford the move`);
      bal.set(w, before + m.delta);
    }
    game = result.game;
    return result;
  };
  return { run, bal, get game() { return game; }, eligible: (w: string) => eligibleSet.add(w) };
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

test("suggest: costs 10 points, one open suggestion per wallet per coin", () => {
  const w = world({ a: 100, c: 100, poor: 9 });
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "a", T0);
  assert.equal(w.bal.get("a"), 90);
  refused(() => w.run({ kind: "suggest", text: "Will I eat two bananas?" }, "a", T0 + 1), /already have a suggestion/);
  refused(() => w.run({ kind: "suggest", text: "Will it rain on stream?" }, "poor", T0), /costs 10 points/);
  refused(() => w.run({ kind: "suggest", text: "Hi?" }, "c", T0), /5 to 80/);
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
  // Expired, so the wallet can suggest again.
  expired.run({ kind: "suggest", text: "Will chat win this round?" }, "asker", T0 + 21 * MIN);
});

test("upvote: free, eligible watchers only, once each, never your own", () => {
  const w = world({ a: 100 }, ["a", "b"]);
  w.run({ kind: "suggest", text: "Will I eat a banana?" }, "a", T0);
  refused(() => w.run({ kind: "upvote", id: "1" }, "newcomer", T0), /Watch 15 minutes/);
  refused(() => w.run({ kind: "upvote", id: "1" }, "a", T0), /your own/);
  w.run({ kind: "upvote", id: "1" }, "b", T0);
  refused(() => w.run({ kind: "upvote", id: "1" }, "b", T0), /already upvoted/);
  assert.deepEqual(w.game.suggestions[0].upvoters, ["b"]);
  assert.equal(w.bal.get("b") ?? 0, 0, "upvotes cost nothing");
  refused(() => w.run({ kind: "upvote", id: "9" }, "b", T0), /gone/);
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
  assert.deepEqual([w.bal.get("a"), w.bal.get("b"), w.bal.get("c")], [1_100, 1_300, 600]);
  const total = [...w.bal.values()].reduce((x, y) => x + y, 0);
  assert.equal(total, 3_000, "parimutuel moves points, never makes them");
  const done = w.game.resolved[0];
  assert.deepEqual([done.outcome, done.resolvedBy, done.resolvedAt], ["yes", MOD, T0 + MIN]);
  assert.deepEqual(w.game.won, { a: 100, b: 300, c: -400 });
  refused(() => w.run({ kind: "resolve", outcome: "no" }, MOD, T0 + MIN), /Nothing to resolve/);
});

test("resolve: an empty side or a cancel refunds every bet", () => {
  for (const [bets, outcome] of [[["yes", "yes"], "no"], [["yes", "no"], "cancel"]] as const) {
    const w = world({ a: 1_000, b: 1_000 });
    w.run({ kind: "launch", text: "Will I eat a banana?", windowMin: 1 }, STREAMER, T0);
    w.run({ kind: "bet", side: bets[0], amount: 100 }, "a", T0);
    w.run({ kind: "bet", side: bets[1], amount: 200 }, "b", T0);
    w.run({ kind: "resolve", outcome }, STREAMER, T0 + MIN);
    assert.deepEqual([w.bal.get("a"), w.bal.get("b")], [1_000, 1_000], `${bets} ${outcome}`);
    assert.deepEqual(w.game.won, {});
  }
});

test("auto-cancel: unresolved 60 minutes after lock, with full refunds; then the next one can go live", () => {
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

test("asker reward: +50 only on YES/NO with at least 5 distinct eligible bettors", () => {
  const scenario = (eligibleBettors: number, outcome: "yes" | "cancel") => {
    const bettors = ["b0", "b1", "b2", "b3", "b4", "b5"];
    const balances = Object.fromEntries(bettors.flatMap((b) => [[b, 1_000], [`${b}-new`, 1_000]]));
    const w = withSuggestion(3, balances);
    for (const b of bettors) w.eligible(b);
    // Only the first `eligibleBettors` count as eligible.
    const result = (() => {
      for (const [i, b] of bettors.entries()) {
        if (i >= eligibleBettors) w.run({ kind: "bet", side: i % 2 ? "yes" : "no", amount: 20 }, `${b}-new`, T0 + MIN);
        else w.run({ kind: "bet", side: i % 2 ? "yes" : "no", amount: 20 }, b, T0 + MIN);
      }
      return w.run({ kind: "resolve", outcome }, STREAMER, T0 + 3 * MIN);
    })();
    return { reward: w.game.resolved[0].askerReward, askerMove: result.moves.get("asker")?.delta ?? 0 };
  };
  assert.deepEqual(scenario(5, "yes"), { reward: 50, askerMove: 50 });
  assert.deepEqual(scenario(4, "yes"), { reward: 0, askerMove: 0 });
  assert.deepEqual(scenario(6, "cancel"), { reward: 0, askerMove: 0 });
});

test("flags: bettors only, once each; disputed at 30% of bettors", () => {
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
});

test("a tick with nothing due changes nothing; actions need a signed-in wallet", () => {
  const w = world();
  assert.equal(w.run({ kind: "tick" }, null, T0).changed, false);
  refused(() => w.run({ kind: "upvote", id: "1" }, null, T0), /Sign in/);
});
