import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAction } from "./input";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

test("well-formed actions pass through", () => {
  assert.deepEqual(parseAction({ kind: "suggest", text: "Will I eat a banana?" }), { kind: "suggest", text: "Will I eat a banana?" });
  assert.deepEqual(parseAction({ kind: "upvote", id: "12" }), { kind: "upvote", id: "12" });
  assert.deepEqual(parseAction({ kind: "approve", id: "7" }), { kind: "approve", id: "7" });
  assert.deepEqual(parseAction({ kind: "bet", id: "4", side: "no", amount: 50 }), { kind: "bet", id: "4", side: "no", amount: 50 });
  assert.deepEqual(parseAction({ kind: "launch", id: "3", windowMin: 5 }), { kind: "launch", id: "3", windowMin: 5 });
  assert.deepEqual(parseAction({ kind: "launch", text: "My own question?" }), { kind: "launch", text: "My own question?", windowMin: undefined });
  assert.deepEqual(parseAction({ kind: "resolve", id: "4", outcome: "cancel" }), { kind: "resolve", id: "4", outcome: "cancel" });
  assert.deepEqual(parseAction({ kind: "flag", id: "4" }), { kind: "flag", id: "4" });
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
    { kind: "approve", id: "x" },
    { kind: "upvote", id: "0" },
    { kind: "upvote", id: "__proto__" },
    { kind: "bet", id: "1", side: "maybe", amount: 10 },
    { kind: "bet", id: "1", side: "yes", amount: "10" },
    { kind: "bet", side: "yes", amount: 10 },
    { kind: "bet", id: "0", side: "yes", amount: 10 },
    { kind: "bet", id: 1, side: "yes", amount: 10 },
    { kind: "resolve", id: "1", outcome: "draw" },
    { kind: "resolve", outcome: "yes" },
    { kind: "resolve", id: "__proto__", outcome: "yes" },
    { kind: "flag" },
    { kind: "mod", wallet: "not-a-wallet", add: true },
    { kind: "suggest", text: 5 },
  ];
  for (const body of bad) assert.equal(parseAction(body), null, JSON.stringify(body));
});

test("prediction ids past 9999 still parse, so a busy coin's later predictions can be bet on and resolved", () => {
  assert.deepEqual(parseAction({ kind: "bet", id: "10000", side: "yes", amount: 10 }), { kind: "bet", id: "10000", side: "yes", amount: 10 });
  assert.equal(parseAction({ kind: "bet", id: "1234567890", side: "yes", amount: 10 }), null, "bounded at 9 digits");
});

test("challenge and decide: ids, a reason, an optional link, and only known decisions", () => {
  assert.deepEqual(parseAction({ kind: "challenge", id: "4", reason: "He lost" }), { kind: "challenge", id: "4", reason: "He lost" });
  assert.deepEqual(parseAction({ kind: "challenge", id: "4", reason: "He lost", link: "https://x.example" }), { kind: "challenge", id: "4", reason: "He lost", link: "https://x.example" });
  assert.equal(parseAction({ kind: "challenge", id: "4" }), null);
  assert.equal(parseAction({ kind: "challenge", id: "x", reason: "He lost" }), null);
  assert.deepEqual(parseAction({ kind: "decide", id: "4", decision: "void" }), { kind: "decide", id: "4", decision: "void" });
  assert.equal(parseAction({ kind: "decide", id: "4", decision: "pay me" }), null);
  assert.deepEqual(parseAction({ kind: "launch", text: "Will it rain?", windowMin: 5, source: "https://weather.example" }), { kind: "launch", text: "Will it rain?", windowMin: 5, source: "https://weather.example" });
});
