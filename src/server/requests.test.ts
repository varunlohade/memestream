import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuote, parseSlippage, parseTxRequest } from "./requests";

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

test("slippage: only the whitelist passes, anything else is the 1% default", () => {
  for (const bps of [50, 100, 300, 500]) {
    assert.equal(parseSlippage(bps), bps);
    assert.equal(parseSlippage(String(bps)), bps);
  }
  for (const bad of [0, 10_000, -1, "abc", undefined, null, "", 5_000, 300.5, "300.0", " 300", "-1", "1e2"]) {
    assert.equal(parseSlippage(bad), 100, `for ${JSON.stringify(bad)}`);
  }
});

test("a trade uses the picked slippage only from the whitelist", () => {
  const slippageOf = (slippageBps: unknown) => {
    const trade = parseTxRequest("trade", { wallet: "W", mint: "M", side: "sell", amount: "5", slippageBps });
    return trade.action === "trade" ? trade.req.slippageBps : null;
  };
  assert.equal(slippageOf(300), 300);
  assert.equal(slippageOf(5_000), 100);
  assert.equal(slippageOf(undefined), 100);
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
  assert.equal(parseQuote(new URLSearchParams({ mint: "M", side: "buy", amount: "0.5", slippageBps: "500" })).slippageBps, 500);
  assert.equal(parseQuote(new URLSearchParams({ mint: "M", side: "buy", amount: "0.5", slippageBps: "10000" })).slippageBps, 100);
  assert.throws(() => parseQuote(new URLSearchParams({ mint: "M", side: "buy" })), /Missing amount/);
  assert.throws(() => parseQuote(new URLSearchParams({ side: "buy", amount: "1" })), /Missing mint/);
});
