import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuote, parseTxRequest } from "./requests";

test("parses each action", () => {
  assert.equal(parseTxRequest("claim", { wallet: "W", mint: "M" }).action, "claim");
  assert.equal(parseTxRequest("graduate", { wallet: "W", mint: "M" }).action, "graduate");
  assert.equal(parseTxRequest("launch", { wallet: "W", name: "N", symbol: "S" }).action, "launch");
});

test("a trade keeps the minimum the user saw, only as a string", () => {
  const trade = (minReceived: unknown) => parseTxRequest("trade", { wallet: "W", mint: "M", side: "buy", amount: "1", minReceived });
  const minOf = (parsed: ReturnType<typeof trade>) => (parsed.action === "trade" ? parsed.req.minReceived : null);
  assert.equal(minOf(trade("123.5")), "123.5");
  assert.equal(minOf(trade(undefined)), undefined);
  assert.equal(minOf(trade(42)), undefined);
});

test("a trade always uses the default slippage", () => {
  const trade = parseTxRequest("trade", { wallet: "W", mint: "M", side: "sell", amount: "5", slippageBps: 5_000 });
  assert.equal(trade.action === "trade" && trade.req.slippageBps, 100);
});

test("a launch keeps only a string stream link", () => {
  const launch = (streamUrl: unknown) => parseTxRequest("launch", { wallet: "W", name: "N", symbol: "S", streamUrl });
  const linkOf = (parsed: ReturnType<typeof launch>) => (parsed.action === "launch" ? parsed.req.streamUrl : null);
  assert.equal(linkOf(launch("https://twitch.tv/x")), "https://twitch.tv/x");
  assert.equal(linkOf(launch(42)), undefined);
});

test("rejects bad input", () => {
  assert.throws(() => parseTxRequest("drain", { wallet: "W" }), /Unknown action/);
  assert.throws(() => parseTxRequest("trade", { wallet: "W", mint: "M", side: "short", amount: "1" }), /Side must be/);
  assert.throws(() => parseTxRequest("launch", { wallet: "W", name: " ", symbol: "X" }), /Missing name/);
  assert.throws(() => parseTxRequest("claim", { mint: "M" }), /Missing wallet/);
  assert.throws(() => parseTxRequest("claim", { wallet: 7, mint: "M" }), /Missing wallet/);
});

test("parses quote query params", () => {
  const q = parseQuote(new URLSearchParams({ mint: "M", side: "buy", amount: "0.5" }));
  assert.deepEqual(q, { mint: "M", side: "buy", amount: "0.5", slippageBps: 100 });
  assert.throws(() => parseQuote(new URLSearchParams({ mint: "M", side: "buy" })), /Missing amount/);
  assert.throws(() => parseQuote(new URLSearchParams({ side: "buy", amount: "1" })), /Missing mint/);
});

test("market bets and redemptions go through the tx flow with the /api/markets bodies", () => {
  const ref = { mint: "So11111111111111111111111111111111111111112", predictionId: "7" };
  const bet = parseTxRequest("market", { ...ref, wallet: "w", side: "no", action: "sell", amount: "1.5", minReceived: "0.4", slippageBps: 9000 });
  assert.deepEqual(bet, { action: "market", req: { ...ref, wallet: "w", side: "no", action: "sell", amount: "1.5", minReceived: "0.4", slippageBps: 100 } });
  assert.deepEqual(parseTxRequest("market-redeem", { ...ref, wallet: "w" }), { action: "market-redeem", req: { ...ref, wallet: "w" } });
  assert.throws(() => parseTxRequest("market", { ...ref, wallet: "w", side: "maybe", action: "buy", amount: "1" }), /yes or no/);
  assert.throws(() => parseTxRequest("market-redeem", { wallet: "w", mint: ref.mint }), /Missing predictionId/);
});
