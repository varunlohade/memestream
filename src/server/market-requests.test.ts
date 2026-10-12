import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SLIPPAGE_BPS } from "@/lib/api-types";
import { parseMarketRequest } from "./market-requests";

const ref = { mint: "So11111111111111111111111111111111111111112", predictionId: "42" };

test("odds and redeem need the market; redeem also the wallet", () => {
  assert.deepEqual(parseMarketRequest("odds", ref), { action: "odds", req: { ...ref, wallet: null } });
  assert.deepEqual(parseMarketRequest("odds", { ...ref, wallet: "w" }), { action: "odds", req: { ...ref, wallet: "w" } }, "a wallet adds its position");
  assert.deepEqual(parseMarketRequest("redeem", { ...ref, wallet: "w" }), { action: "redeem", req: { ...ref, wallet: "w" } });
  assert.throws(() => parseMarketRequest("redeem", ref), /Missing wallet/);
  assert.throws(() => parseMarketRequest("odds", { mint: ref.mint }), /Missing predictionId/);
});

test("a bet names its side and buy or sell; slippage is always the default", () => {
  const body = { ...ref, side: "yes", action: "buy", amount: "0.1", slippageBps: 4999 };
  assert.deepEqual(parseMarketRequest("preview", body), {
    action: "preview",
    req: { ...ref, side: "yes", action: "buy", amount: "0.1", slippageBps: DEFAULT_SLIPPAGE_BPS },
  });
  const trade = parseMarketRequest("trade", { ...body, wallet: "w", minReceived: "0.18" });
  assert.equal(trade.action, "trade");
  assert.deepEqual(trade.req, { ...ref, side: "yes", action: "buy", amount: "0.1", slippageBps: DEFAULT_SLIPPAGE_BPS, wallet: "w", minReceived: "0.18" });
});

test("rejects unknown actions, sides and directions", () => {
  assert.throws(() => parseMarketRequest("resolve", ref), /Unknown action/);
  assert.throws(() => parseMarketRequest("preview", { ...ref, side: "maybe", action: "buy", amount: "1" }), /yes or no/);
  assert.throws(() => parseMarketRequest("preview", { ...ref, side: "no", action: "hold", amount: "1" }), /buy or sell/);
  assert.throws(() => parseMarketRequest("trade", { ...ref, side: "no", action: "sell", amount: "1" }), /Missing wallet/);
});
