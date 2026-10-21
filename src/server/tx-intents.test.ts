// The server's double-pay check: an identical build while an earlier one is still confirming is
// refused with 409; anything else goes through.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParsedTx } from "./requests";
import { BUILD_HOLD_MS, DUPLICATE_MESSAGE, duplicateResponse, intentKey, isIntentToken, memoryIntentStore, SIGNED_HOLD_MS, txIntents } from "./tx-intents";

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
  const token = (await intents.remember(key, HASH, T0)) as string;
  clock.t = T0 + 1_000;
  await intents.report(token, HASH, SIG, "pending", clock.t);
  return { clock, intents, key, token };
}

test("an identical trade while the first is signed and pending is refused with 409", async () => {
  const { intents, key } = await setup();
  assert.deepEqual(await intents.pending(key, T0 + 5_000), { signature: SIG });
  const response = duplicateResponse(SIG);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: DUPLICATE_MESSAGE, duplicate: true, pendingSignature: SIG });
  assert.equal(DUPLICATE_MESSAGE, "This trade may still be on its way. Wait up to 2 minutes or check your wallet before trying again.");
});

test("slippage and the quoted minimum don't make a trade different", () => {
  assert.equal(intentKey(trade({ slippageBps: 500, minReceived: "4" })), intentKey(trade()));
});

test("amounts compare in base units: 0.1, 0.10, .1 and ' 0.100 ' are one trade", () => {
  for (const amount of ["0.10", ".1", " 0.100 ", "0.100000000"]) assert.equal(intentKey(trade({ amount })), intentKey(trade()), amount);
  assert.notEqual(intentKey(trade({ amount: "0.1000000001" })), intentKey(trade()), "past SOL's 9 decimals stays as typed (the build refuses it)");
  assert.equal(intentKey(trade({ side: "sell", amount: "5" })), intentKey(trade({ side: "sell", amount: "5.000000" })));
  const bet = (amount: string): ParsedTx => ({
    action: "market",
    req: { wallet: "walletA", mint: "mintA", predictionId: "1", side: "yes", action: "buy", amount, slippageBps: 100 },
  });
  assert.equal(intentKey(bet(".5")), intentKey(bet("0.50")));
  assert.notEqual(intentKey(bet("0.5")), intentKey(bet("0.6")));
});

test("a second identical build within the hold is refused even before any status poll", async () => {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  assert.match((await intents.remember(key, HASH, T0)) ?? "", /^[0-9a-f]{32}\./);
  clock.t = T0 + 5_000;
  assert.deepEqual(await intents.pending(key, clock.t), { signature: null }, "the popup is still open: held");
  assert.equal(await intents.remember(key, HASH, clock.t), null, "a racing build is never handed out, and never overwrites");
  assert.equal(await intents.pending(intentKey(trade({ amount: "0.2" })), clock.t), null, "a different amount still goes through");
});

test("a client that never reports lets the hold lapse after the build hold", async () => {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  await intents.remember(key, HASH, T0);
  clock.t = T0 + BUILD_HOLD_MS - 1;
  assert.notEqual(await intents.pending(key, clock.t), null);
  clock.t = T0 + BUILD_HOLD_MS;
  assert.equal(await intents.pending(key, clock.t), null);
  assert.notEqual(await intents.remember(key, HASH, clock.t), null);
});

test("a popup open longer than the build hold: a late signature report blocks an identical rebuild again", async () => {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  const token = (await intents.remember(key, HASH, T0)) as string;
  clock.t = T0 + BUILD_HOLD_MS + 5_000; // the hold lapsed while the popup stayed open
  assert.equal(await intents.pending(key, clock.t), null);
  await intents.report(token, HASH, SIG, "pending", clock.t);
  assert.deepEqual(await intents.pending(key, clock.t + 1_000), { signature: SIG });
  assert.equal(await intents.remember(key, HASH, clock.t + 1_000), null);
  clock.t = T0 + BUILD_HOLD_MS + 5_000 + SIGNED_HOLD_MS - BUILD_HOLD_MS;
  assert.equal(await intents.pending(key, clock.t), null, "it lapses at most SIGNED_HOLD_MS after the build");
});

test("a made-up token can never create a hold (no build, or the wrong blockhash or id)", async () => {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  // An attacker who knows the victim's trade inputs forges a token: no build ever happened.
  await intents.report(`${key}.00000000-0000-4000-8000-000000000000`, HASH, SIG, "pending", clock.t);
  assert.equal(await intents.pending(key, clock.t), null, "no 409 for the victim");
  assert.notEqual(await intents.remember(key, HASH, clock.t), null, "the victim's trade builds");

  // A real build whose hold lapsed: a report with another blockhash, or another id, does nothing.
  clock.t += BUILD_HOLD_MS + 1;
  const real = (await txIntents(memoryIntentStore(() => clock.t)).remember(key, HASH, clock.t)) as string;
  const store = memoryIntentStore(() => clock.t);
  const fresh = txIntents(store);
  const token = (await fresh.remember(key, HASH, clock.t)) as string;
  clock.t += BUILD_HOLD_MS + 1;
  await fresh.report(token, "x".repeat(43), SIG, "pending", clock.t);
  await fresh.report(real, HASH, SIG, "pending", clock.t);
  assert.equal(await fresh.pending(key, clock.t), null, "a wrong blockhash or a token from elsewhere adds no hold");
  await fresh.report(token, HASH, SIG, "pending", clock.t);
  assert.deepEqual(await fresh.pending(key, clock.t), { signature: SIG }, "the real build's late report still holds");
});

test("a late report never overwrites a newer build's record", async () => {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  const old = (await intents.remember(key, HASH, T0)) as string;
  clock.t = T0 + BUILD_HOLD_MS;
  const fresh = (await intents.remember(key, HASH, clock.t)) as string;
  await intents.report(old, HASH, SIG, "pending", clock.t + 1);
  await intents.release(fresh);
  assert.equal(await intents.pending(key, clock.t + 2), null, "the newer build's record was the one there; the old report added nothing");
});

test("a wallet rejection releases the hold: the same trade can be built again at once", async () => {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  const token = (await intents.remember(key, HASH, T0)) as string;
  await intents.release(token);
  assert.equal(await intents.pending(key, T0 + 1), null);
  assert.notEqual(await intents.remember(key, HASH, T0 + 1), null);
});

test("a rejection can't release a signed intent, another build's intent, or another wallet's", async () => {
  const { intents, key, token } = await setup();
  await intents.release(token); // signed already: a late "rejected" is ignored
  assert.deepEqual(await intents.pending(key, T0 + 2_000), { signature: SIG });

  const clock = { t: T0 };
  const fresh = txIntents(memoryIntentStore(() => clock.t));
  const keyA = intentKey(trade());
  const keyB = intentKey(trade({ wallet: "walletB" }));
  await fresh.remember(keyA, HASH, T0);
  const tokenB = (await fresh.remember(keyB, HASH, T0)) as string;
  await fresh.release(tokenB);
  await fresh.release(`${keyA}.00000000-0000-4000-8000-000000000000`);
  assert.notEqual(await fresh.pending(keyA, T0 + 1), null, "wallet A is still held");
  assert.equal(await fresh.pending(keyB, T0 + 1), null);
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

for (const status of ["confirmed", "failed"] as const) {
  test(`once the first is ${status}, the same trade goes through`, async () => {
    const { intents, key, token } = await setup();
    await intents.report(token, HASH, SIG, status, T0 + 5_000);
    assert.equal(await intents.pending(key, T0 + 6_000), null);
  });
}

test("expired (the server's blockhash died) keeps the hold until the signed hold ends: the wallet's own blockhash may still land", async () => {
  const { intents, key, token } = await setup();
  await intents.report(token, HASH, SIG, "expired", T0 + 100_000);
  assert.deepEqual(await intents.pending(key, T0 + 100_001), { signature: SIG });
  assert.deepEqual(await intents.pending(key, T0 + SIGNED_HOLD_MS - 1), { signature: SIG });
  assert.equal(await intents.pending(key, T0 + SIGNED_HOLD_MS), null);
});

test("signed, it stays held past the build hold until the signed hold ends", async () => {
  const { clock, intents, key } = await setup();
  clock.t = T0 + BUILD_HOLD_MS + 10_000;
  assert.deepEqual(await intents.pending(key, clock.t), { signature: SIG });
  clock.t = T0 + SIGNED_HOLD_MS - 1;
  assert.deepEqual(await intents.pending(key, clock.t), { signature: SIG });
  clock.t = T0 + SIGNED_HOLD_MS;
  assert.equal(await intents.pending(key, clock.t), null);
});

test("a report with a wrong token, id or blockhash changes nothing", async () => {
  const { intents, key, token } = await setup();
  const otherId = `${key}.00000000-0000-4000-8000-000000000000`;
  await intents.report(otherId, HASH, SIG, "confirmed", T0 + 2_000);
  await intents.report(token, "x".repeat(43), SIG, "confirmed", T0 + 2_000);
  await intents.report("not-a-token", HASH, SIG, "confirmed", T0 + 2_000);
  assert.deepEqual(await intents.pending(key, T0 + 3_000), { signature: SIG });
  assert.equal(isIntentToken(token), true);
  assert.equal(isIntentToken("x"), false);
});

test("after the first resolves, a new build is held on its own; the old token can't clear it", async () => {
  const { intents, key, token } = await setup();
  // The first one confirmed elsewhere and the user trades again: the new one is tracked on its own.
  await intents.report(token, HASH, SIG, "confirmed", T0 + 2_000);
  const second = (await intents.remember(key, HASH, T0 + 3_000)) as string;
  await intents.report(second, HASH, "t".repeat(87), "pending", T0 + 4_000);
  await intents.report(token, HASH, SIG, "confirmed", T0 + 5_000);
  assert.deepEqual(await intents.pending(key, T0 + 6_000), { signature: "t".repeat(87) });
});

test("a store that throws lets the trade through", async () => {
  const down = () => Promise.reject(new Error("down"));
  const broken = { get: down, set: down, add: down, del: down };
  const intents = txIntents(broken);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await intents.pending(intentKey(trade()), T0), null);
    assert.match((await intents.remember(intentKey(trade()), HASH, T0)) ?? "", /^[0-9a-f]{32}\./);
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
    const token = (await intents.remember(key, HASH, now)) as string;
    await intents.report(token, HASH, SIG, "pending", now);
    assert.deepEqual(await intents.pending(key, now), { signature: SIG });
    assert.equal(await intents.remember(key, HASH, now), null, "the fallback also never overwrites");
  } finally {
    console.warn = warn;
  }
});

test("a wallet error that wasn't a rejection (maybe sent, no signature): held as long as a signed one, and a rejection report can't drop it", async () => {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  const token = (await intents.remember(key, HASH, T0)) as string;
  await intents.maybeSent(token, T0 + 2_000);
  await intents.release(token);
  assert.deepEqual(await intents.pending(key, T0 + BUILD_HOLD_MS + 10_000), { signature: null }, "past the build hold: still held");
  assert.deepEqual(await intents.pending(key, T0 + SIGNED_HOLD_MS - 1), { signature: null });
  assert.equal(await intents.pending(key, T0 + SIGNED_HOLD_MS), null);
});

test("a wallet error reported after the build hold lapsed holds it again, only for a real build", async () => {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  const token = (await intents.remember(key, HASH, T0)) as string;
  clock.t = T0 + BUILD_HOLD_MS + 5_000;
  assert.equal(await intents.pending(key, clock.t), null, "the build hold lapsed");
  await intents.maybeSent(`${key}.00000000-0000-4000-8000-000000000000`, clock.t);
  assert.equal(await intents.pending(key, clock.t), null, "a made-up token holds nothing");
  await intents.maybeSent(token, clock.t);
  assert.deepEqual(await intents.pending(key, clock.t + 1_000), { signature: null });
  assert.equal(await intents.pending(key, T0 + SIGNED_HOLD_MS), null, "until the signed hold ends");
});

test("a wallet error never replaces a reported signature", async () => {
  const { intents, key, token } = await setup();
  await intents.maybeSent(token, T0 + 2_000);
  assert.deepEqual(await intents.pending(key, T0 + 3_000), { signature: SIG });
});

test("a trade reported confirmed or failed is done: a late wallet-error or rejection report never holds or touches it again", async () => {
  for (const status of ["confirmed", "failed"] as const) {
    const { intents, key, token } = await setup();
    await intents.report(token, HASH, SIG, status, T0 + 5_000);
    await intents.maybeSent(token, T0 + 6_000);
    assert.equal(await intents.pending(key, T0 + 7_000), null, `${status}: no new hold`);
    const next = (await intents.remember(key, HASH, T0 + 8_000)) as string;
    await intents.release(token);
    assert.deepEqual(await intents.pending(key, T0 + 9_000), { signature: null }, "the old token can't drop the new build's hold");
    assert.ok(next);
  }
});

test("done also when the confirm report comes after the build hold lapsed", async () => {
  const clock = { t: T0 };
  const intents = txIntents(memoryIntentStore(() => clock.t));
  const key = intentKey(trade());
  const token = (await intents.remember(key, HASH, T0)) as string;
  clock.t = T0 + BUILD_HOLD_MS + 1_000;
  await intents.report(token, HASH, SIG, "confirmed", clock.t);
  await intents.maybeSent(token, clock.t + 1_000);
  assert.equal(await intents.pending(key, clock.t + 2_000), null);
});
