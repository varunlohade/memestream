import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, apply, applyReview, type Game, newGame, STAFF } from "@/lib/predictions/engine";
import {
  AI_CHECK_MAX_TRIES,
  CHALLENGE_BOND,
  CHALLENGE_REASON_MAX,
  LINK_MAX,
  BET_WINDOWS_MIN,
  FRAME_NOTE_MAX,
  MAX_BET,
  MAX_BETTORS,
  MAX_HISTORY,
  MAX_LIVE,
  MAX_MODS,
  MAX_NOTICES,
  MAX_PREDICTIONS_PER_STREAM,
  MAX_QUEUE,
  MAX_UPVOTES,
  MAX_WON_ENTRIES,
  NOTICE_MS,
  QUESTION_MAX,
  REVIEW_MAX_TRIES,
} from "@/lib/predictions/rules";
import { GAME_KEY_COUNT, loadGame } from "./game-doc";

const MIN = 60_000;
const T0 = 1_000_000_000;
/** Real wallet addresses are up to 44 characters. */
const wallet = (tag: string, i: number) => `${tag}${i}`.padEnd(44, "W");
const STREAMER = wallet("streamer", 0);
const actor = (w: string): Actor => ({ wallet: w, eligible: true, holder: true, balance: 1_000_000 });
const question = (i: number) => `Q${i} `.padEnd(QUESTION_MAX - 1, "x") + "?";

/** Redis documents are kept under 256 KB, since every action and GET reads them and every action rewrites them. */
const DOC_CAP = 262_144;

test("a coin's game at full caps, MAX_LIVE live: the coin document and every other document stay under 256 KB", () => {
  const step = (game: Game, action: Parameters<typeof apply>[1], who: string | null, now: number) => apply(game, action, who ? actor(who) : null, now).game;
  const bettors = Array.from({ length: MAX_BETTORS }, (_, i) => wallet("bettor", i));

  let game = newGame(STREAMER);
  for (let i = 0; i < MAX_MODS; i++) game = step(game, { kind: "mod", wallet: wallet("mod", i), add: true }, STREAMER, T0);

  // One full result in its flag window, built by the engine: every bettor bet the most and flagged it.
  game = step(game, { kind: "launch", text: question(0) }, STREAMER, T0);
  game = applyReview(game, game.pending!, { approved: true, windowMin: BET_WINDOWS_MIN[0] }, T0).game;
  for (const [i, b] of bettors.entries()) game = step(game, { kind: "bet", id: game.live[0].id, side: i % 2 ? "yes" : "no", amount: MAX_BET }, b, T0);
  game = step(game, { kind: "resolve", id: game.live[0].id, outcome: "yes" }, STREAMER, T0 + MIN);
  for (const b of bettors) game = step(game, { kind: "flag", id: game.resolved[0].id }, b, T0 + MIN);
  const open = game.resolved[0];

  // One full suggestion, built by the engine.
  game = step(game, { kind: "suggest", text: question(1) }, wallet("asker", 0), T0 + MIN);
  game = applyReview(game, game.suggestions[0], { approved: true, windowMin: BET_WINDOWS_MIN.at(-1) }, T0 + MIN).game;
  for (let i = 0; i < MAX_UPVOTES; i++) game = step(game, { kind: "upvote", id: game.suggestions[0].id }, wallet("voter", i), T0 + MIN);
  const suggestion = game.suggestions[0];

  // Then the same shapes copied up to every cap. A result can resolve once a minute at the soonest,
  // MAX_LIVE at a time, but a stream launches at most MAX_PREDICTIONS_PER_STREAM. A new stream can
  // also start while up to MAX_LIVE from the last one are still live (nobody looked for over an
  // hour); they cancel at once and sit in their flag window beside the new stream's results.
  // Open ones also carry an AI check still running with its launch and lock frames at their longest.
  // Worst case: a stream boundary mid-window leaves a full stream's results open while the next stream adds its own.
  const openAtOnce = 2 * MAX_PREDICTIONS_PER_STREAM;
  const note = (kind: "launch" | "lock") => ({ kind, at: T0, text: "x".repeat(FRAME_NOTE_MAX) });
  const frames = [note("launch"), note("lock")];
  // Every prediction also carries its on-chain market at its longest (MEMESTREAM_MARKETS).
  const market = {
    step: "resolved" as const,
    tries: 1_000,
    at: T0,
    question: wallet("question", 0),
    challenge: { by: wallet("challenger", 0), at: T0, reason: "r".repeat(CHALLENGE_REASON_MAX), link: `https://x.example/${"l".repeat(LINK_MAX - 18)}`, bond: CHALLENGE_BOND },
    closed: true,
    decision: { outcome: "refund" as const, by: wallet("admin", 0), at: T0 },
  };
  const source = `https://source.example/${"s".repeat(LINK_MAX - 23)}`;
  const marketed = { market, source, window: [T0, T0] as [number, number] };
  const summary = { ...open, open: null, flags: MAX_BETTORS, ai: { verdict: "disagree" as const, at: T0 }, ...marketed };
  game.resolved = Array.from({ length: Math.max(MAX_HISTORY, openAtOnce) }, (_, i) =>
    i < openAtOnce
      ? { ...structuredClone(open), id: String(1_000 + i), check: { tries: AI_CHECK_MAX_TRIES, at: T0, frames }, ...marketed }
      : { ...summary, id: String(1_000 + i) },
  );
  game.suggestions = Array.from({ length: MAX_QUEUE }, (_, i) => ({
    ...structuredClone(suggestion),
    id: String(2_000 + i),
    asker: wallet("asker", i),
    review: { tries: REVIEW_MAX_TRIES, at: T0 + 10 * MIN },
  }));
  const bets = Object.fromEntries(bettors.map((b) => [b, { side: "yes" as const, amount: MAX_BET, eligible: false }]));
  game.live = Array.from({ length: MAX_LIVE }, (_, i) => ({
    id: String(3_000 + i),
    text: question(2),
    asker: wallet("asker", 0),
    launchedAt: T0,
    lockAt: T0,
    launchedBy: wallet("mod", 0),
    bets,
    yes: MAX_BET * MAX_BETTORS,
    no: 0,
    bettors: MAX_BETTORS,
    frames,
    market,
    source,
  }));
  game.won = Object.fromEntries(Array.from({ length: MAX_WON_ENTRIES }, (_, i) => [wallet("winner", i), -1_000_000]));
  game.nextId = 1_000_000;
  // A staff question under review, and every "wasn't approved" note at its longest.
  game.pending = { id: "999999", text: question(3), by: wallet("mod", 0), at: T0 + 10 * MIN, review: { tries: REVIEW_MAX_TRIES, at: T0 + 10 * MIN }, source };
  const longNote = "Your question wasn't approved: " + "x".repeat(40);
  game.notices = Array.from({ length: MAX_NOTICES }, (_, i) => ({ to: i === 0 ? STAFF : wallet("asker", i), text: longNote, until: T0 + 10 * MIN + NOTICE_MS }));

  assert.equal(Object.keys(open.open!.results).length, MAX_BETTORS);
  assert.equal(suggestion.upvotes, MAX_UPVOTES);
  const docs = loadGame("m".repeat(44), Array.from({ length: GAME_KEY_COUNT }, () => ({ v: 0, json: null })), STREAMER).save(game);
  const sizes = docs.map((d) => [d.key.replace("m".repeat(44), "<mint>"), d.json!.length] as const);
  assert.equal(sizes.length, GAME_KEY_COUNT, "the coin document and every other one written");
  for (const [key, size] of sizes) assert.ok(size < DOC_CAP, `${key} is ${size} bytes`);
});
