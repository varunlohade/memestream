// The server's double-pay check: an identical build while an earlier one is still confirming is
// refused with 409; anything else goes through.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParsedTx } from "./requests";
import { DUPLICATE_MESSAGE, duplicateResponse, INTENT_WINDOW_MS, intentKey, isIntentToken, memoryIntentStore, txIntents } from "./tx-intents";

const T0 = 1_000_000;
const HASH = "h".repeat(43);
const SIG = "s".repeat(87);
const trade = (patch: Partial<Extract<ParsedTx, { action: "trade" }>["req"]> = {}): ParsedTx => ({
  action: "trade",
  req: { wallet: "walletA", mint: "mintA", side: "buy", amount: "0.1", slippageBps: 100, minReceived: "5", ...patch },
});

/** A clock the test moves, a fresh store, and one trade built and signed at T0. */
async function setup() {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  const token = await intents.remember(key, HASH, T0);
  await intents.report(token, HASH, SIG, "pending", T0 + 1_000);
  return { clock, intents, key, token };
}

test("an identical trade while the first is signed and pending is refused with 409", async () => {
  const { intents, key } = await setup();
  assert.equal(await intents.pending(key, T0 + 5_000), SIG);
  const response = duplicateResponse(SIG);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: DUPLICATE_MESSAGE, duplicate: true, pendingSignature: SIG });
  assert.equal(DUPLICATE_MESSAGE, "Your last trade is still confirming. Check your wallet before trading again.");
});

test("slippage and the quoted minimum don't make a trade different", () => {
  assert.equal(intentKey(trade({ slippageBps: 500, minReceived: "4" })), intentKey(trade()));
});

test("a different amount, side, coin or action goes through", async () => {
  const { intents } = await setup();
  for (const other of [trade({ amount: "0.2" }), trade({ side: "sell" }), trade({ mint: "mintB" })]) {
    assert.equal(await intents.pending(intentKey(other), T0 + 5_000), null);
  }
  const claim: ParsedTx = { action: "claim", req: { wallet: "walletA", mint: "mintA" } };
  assert.equal(await intents.pending(intentKey(claim), T0 + 5_000), null);
});

test("it's per wallet: another wallet's identical trade goes through", async () => {
  const { intents } = await setup();
  assert.equal(await intents.pending(intentKey(trade({ wallet: "walletB" })), T0 + 5_000), null);
});

test("built but never signed (rejected in the wallet) doesn't block a retry", async () => {
  const intents = txIntents(memoryIntentStore(() => T0));
  const key = intentKey(trade());
  await intents.remember(key, HASH, T0);
  assert.equal(await intents.pending(key, T0 + 1_000), null);
});

for (const status of ["confirmed", "failed", "expired"] as const) {
  test(`once the first is ${status}, the same trade goes through`, async () => {
    const { intents, key, token } = await setup();
    await intents.report(token, HASH, SIG, status, T0 + 5_000);
    assert.equal(await intents.pending(key, T0 + 6_000), null);
  });
}

test("after the window (the blockhash's life) the same trade goes through", async () => {
  const { intents, key } = await setup();
  assert.equal(await intents.pending(key, T0 + INTENT_WINDOW_MS - 1), SIG);
  assert.equal(await intents.pending(key, T0 + INTENT_WINDOW_MS), null);
});

test("a report with a wrong token, id or blockhash changes nothing", async () => {
  const { intents, key, token } = await setup();
  const otherId = `${key}.00000000-0000-4000-8000-000000000000`;
  await intents.report(otherId, HASH, SIG, "confirmed", T0 + 2_000);
  await intents.report(token, "x".repeat(43), SIG, "confirmed", T0 + 2_000);
  await intents.report("not-a-token", HASH, SIG, "confirmed", T0 + 2_000);
  assert.equal(await intents.pending(key, T0 + 3_000), SIG);
  assert.equal(isIntentToken(token), true);
  assert.equal(isIntentToken("x"), false);
});

test("a newer build of the same trade replaces the record; the old token can't clear it", async () => {
  const { intents, key, token } = await setup();
  // The first one confirmed elsewhere and the user trades again: the new one is tracked on its own.
  await intents.report(token, HASH, SIG, "confirmed", T0 + 2_000);
  const second = await intents.remember(key, HASH, T0 + 3_000);
  await intents.report(second, HASH, "t".repeat(87), "pending", T0 + 4_000);
  await intents.report(token, HASH, SIG, "confirmed", T0 + 5_000);
  assert.equal(await intents.pending(key, T0 + 6_000), "t".repeat(87));
});

test("a store that throws lets the trade through", async () => {
  const broken = { get: () => Promise.reject(new Error("down")), set: () => Promise.reject(new Error("down")), del: () => Promise.reject(new Error("down")) };
  const intents = txIntents(broken);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await intents.pending(intentKey(trade()), T0), null);
    assert.match(await intents.remember(intentKey(trade()), HASH, T0), /^[0-9a-f]{32}\./);
  } finally {
    console.warn = warn;
  }
});

test("with Redis unreachable, the shared store falls back to memory and still dedupes", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:9"; // nothing listens on the discard port
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  const { sharedIntentStore } = await import("./tx-intents");
  const intents = txIntents(sharedIntentStore());
  const warn = console.warn;
  console.warn = () => {};
  try {
    const now = Date.now();
    const key = intentKey(trade());
    const token = await intents.remember(key, HASH, now);
    await intents.report(token, HASH, SIG, "pending", now);
    assert.equal(await intents.pending(key, now), SIG);
  } finally {
    console.warn = warn;
  }
});
