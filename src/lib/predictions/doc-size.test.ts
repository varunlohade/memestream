import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, apply, applyReview, type Game, newGame, STAFF } from "./engine";
import {
  BET_WINDOWS_MIN,
  FLAG_WINDOW_MS,
  MAX_BET,
  MAX_BETTORS,
  MAX_HISTORY,
  MAX_MODS,
  MAX_NOTICES,
  MAX_QUEUE,
  MAX_UPVOTES,
  MAX_WON_ENTRIES,
  NOTICE_MS,
  QUESTION_MAX,
  REVIEW_MAX_TRIES,
} from "./rules";

const MIN = 60_000;
const T0 = 1_000_000_000;
/** Real wallet addresses are up to 44 characters. */
const wallet = (tag: string, i: number) => `${tag}${i}`.padEnd(44, "W");
const STREAMER = wallet("streamer", 0);
const actor = (w: string): Actor => ({ wallet: w, eligible: true, holder: true, balance: 1_000_000 });
const question = (i: number) => `Q${i} `.padEnd(QUESTION_MAX - 1, "x") + "?";

test("a coin's game document at full caps stays under 256 KB", () => {
  const step = (game: Game, action: Parameters<typeof apply>[1], who: string | null, now: number) => apply(game, action, who ? actor(who) : null, now).game;
  const bettors = Array.from({ length: MAX_BETTORS }, (_, i) => wallet("bettor", i));

  let game = newGame(STREAMER);
  for (let i = 0; i < MAX_MODS; i++) game = step(game, { kind: "mod", wallet: wallet("mod", i), add: true }, STREAMER, T0);

  // One full result in its flag window, built by the engine: every bettor bet the most and flagged it.
  game = step(game, { kind: "launch", text: question(0), windowMin: BET_WINDOWS_MIN[0] }, STREAMER, T0);
  game = applyReview(game, game.pending!, { approved: true }, T0).game;
  for (const [i, b] of bettors.entries()) game = step(game, { kind: "bet", side: i % 2 ? "yes" : "no", amount: MAX_BET }, b, T0);
  game = step(game, { kind: "resolve", outcome: "yes" }, STREAMER, T0 + MIN);
  for (const b of bettors) game = step(game, { kind: "flag", id: game.resolved[0].id }, b, T0 + MIN);
  const open = game.resolved[0];

  // One full suggestion, built by the engine.
  game = step(game, { kind: "suggest", text: question(1) }, wallet("asker", 0), T0 + MIN);
  game = applyReview(game, game.suggestions[0], { approved: true }, T0 + MIN).game;
  for (let i = 0; i < MAX_UPVOTES; i++) game = step(game, { kind: "upvote", id: game.suggestions[0].id }, wallet("voter", i), T0 + MIN);
  const suggestion = game.suggestions[0];

  // Then the same shapes copied up to every cap: a result can resolve once a minute at the
  // soonest, so at most this many sit in their flag window at once.
  const openAtOnce = FLAG_WINDOW_MS / (BET_WINDOWS_MIN[0] * MIN);
  const summary = { ...open, open: null, flags: MAX_BETTORS };
  game.resolved = Array.from({ length: Math.max(MAX_HISTORY, openAtOnce) }, (_, i) =>
    i < openAtOnce ? { ...structuredClone(open), id: String(1_000 + i) } : { ...summary, id: String(1_000 + i) },
  );
  game.suggestions = Array.from({ length: MAX_QUEUE }, (_, i) => ({
    ...structuredClone(suggestion),
    id: String(2_000 + i),
    asker: wallet("asker", i),
    review: { tries: REVIEW_MAX_TRIES, at: T0 + 10 * MIN },
  }));
  const bets = Object.fromEntries(bettors.map((b) => [b, { side: "yes" as const, amount: MAX_BET, eligible: false }]));
  game.live = { id: "3000", text: question(2), asker: wallet("asker", 0), launchedAt: T0, lockAt: T0, launchedBy: wallet("mod", 0), bets, yes: MAX_BET * MAX_BETTORS, no: 0, bettors: MAX_BETTORS };
  game.won = Object.fromEntries(Array.from({ length: MAX_WON_ENTRIES }, (_, i) => [wallet("winner", i), -1_000_000]));
  game.nextId = 1_000_000;
  // A staff question under review, and every "Not approved" note at its longest.
  game.pending = { id: "999999", text: question(3), by: wallet("mod", 0), windowMin: 10, at: T0 + 10 * MIN, review: { tries: REVIEW_MAX_TRIES, at: T0 + 10 * MIN } };
  const longNote = "Not approved: " + "x".repeat(40);
  game.notices = Array.from({ length: MAX_NOTICES }, (_, i) => ({ to: i === 0 ? STAFF : wallet("asker", i), text: longNote, until: T0 + 10 * MIN + NOTICE_MS }));

  assert.equal(Object.keys(open.open!.results).length, MAX_BETTORS);
  assert.equal(suggestion.upvotes, MAX_UPVOTES);
  const size = JSON.stringify(game).length;
  assert.ok(size < 262_144, `document is ${size} bytes`);
});
