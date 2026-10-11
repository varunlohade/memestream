import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAction } from "./input";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

test("well-formed actions pass through", () => {
  assert.deepEqual(parseAction({ kind: "suggest", text: "Will I eat a banana?" }), { kind: "suggest", text: "Will I eat a banana?" });
  assert.deepEqual(parseAction({ kind: "upvote", id: "12" }), { kind: "upvote", id: "12" });
  assert.deepEqual(parseAction({ kind: "bet", side: "no", amount: 50 }), { kind: "bet", side: "no", amount: 50 });
  assert.deepEqual(parseAction({ kind: "launch", id: "3", windowMin: 5 }), { kind: "launch", id: "3", windowMin: 5 });
  assert.deepEqual(parseAction({ kind: "launch", text: "My own question?" }), { kind: "launch", text: "My own question?", windowMin: undefined });
  assert.deepEqual(parseAction({ kind: "resolve", outcome: "cancel" }), { kind: "resolve", outcome: "cancel" });
  assert.deepEqual(parseAction({ kind: "mod", wallet: WALLET, add: true }), { kind: "mod", wallet: WALLET, add: true });
  assert.deepEqual(parseAction({ kind: "crowd", on: false }), { kind: "crowd", on: false });
  assert.equal(parseAction({ kind: "crowd", on: "no" }), null);
});

test("malformed actions, and any way to move points between wallets, are refused", () => {
  const bad = [
    {},
    { kind: "transfer", to: WALLET, amount: 10 },
    { kind: "buy", amount: 10 },
    { kind: "tick" },
    { kind: "upvote", id: "0" },
    { kind: "upvote", id: "__proto__" },
    { kind: "bet", side: "maybe", amount: 10 },
    { kind: "bet", side: "yes", amount: "10" },
    { kind: "resolve", outcome: "draw" },
    { kind: "mod", wallet: "not-a-wallet", add: true },
    { kind: "suggest", text: 5 },
  ];
  for (const body of bad) assert.equal(parseAction(body), null, JSON.stringify(body));
});
