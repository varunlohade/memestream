import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuote, parseTxRequest } from "./requests";

test("parses each action and rejects bad input", () => {
  assert.equal(parseTxRequest("claim", { wallet: "W", mint: "M" }).action, "claim");
  const trade = parseTxRequest("trade", { wallet: "W", mint: "M", side: "sell", amount: "5" });
  assert.equal(trade.action === "trade" && trade.req.minReceived, undefined);
  const seen = parseTxRequest("trade", { wallet: "W", mint: "M", side: "buy", amount: "1", minReceived: "123.5" });
  assert.equal(seen.action === "trade" && seen.req.minReceived, "123.5");
  assert.equal(trade.action === "trade" && trade.req.slippageBps, 100);
  assert.throws(() => parseTxRequest("drain", { wallet: "W" }), /Unknown action/);
  assert.throws(() => parseTxRequest("trade", { wallet: "W", mint: "M", side: "short", amount: "1" }), /Side must be/);
  assert.throws(() => parseTxRequest("launch", { wallet: "W", name: " ", symbol: "X" }), /Missing name/);
  assert.throws(() => parseTxRequest("claim", { mint: "M" }), /Missing wallet/);
});

test("parses quote query params", () => {
  const q = parseQuote(new URLSearchParams({ mint: "M", side: "buy", amount: "0.5" }));
  assert.deepEqual(q, { mint: "M", side: "buy", amount: "0.5", slippageBps: 100 });
  assert.throws(() => parseQuote(new URLSearchParams({ mint: "M", side: "buy" })), /Missing amount/);
});
