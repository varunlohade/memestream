import assert from "node:assert/strict";
import { test } from "node:test";
import { newGame, type Prediction } from "@/lib/predictions/engine";
import { parseGame } from "./game-doc";

const live: Prediction = { id: "7", text: "Will chat win?", asker: null, launchedAt: 1, lockAt: 2, launchedBy: "s", bets: { a: { side: "yes", amount: 10, eligible: false } }, yes: 10, no: 0, bettors: 1 };

test("old documents migrate: `live: X` loads as [X], `live: null` as []", () => {
  assert.deepEqual(parseGame(JSON.stringify({ ...newGame("s"), live }), "s").live, [live]);
  assert.deepEqual(parseGame(JSON.stringify({ ...newGame("s"), live: null }), "s").live, []);
  assert.deepEqual(parseGame(null, "s").live, []);
  assert.deepEqual(parseGame(JSON.stringify({ ...newGame("s"), live: [live] }), "s").live, [live]);
});
