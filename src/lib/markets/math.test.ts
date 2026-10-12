import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { isPredictionId, oddsFromPrices, payoutNumerators, priceFromSqrtPrice, questionIdFor, redeemLamports } from "./math";

const coin = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;

test("a question id is 32 bytes, the same for the same coin and prediction, different otherwise", () => {
  const id = questionIdFor(coin, "42");
  assert.equal(id.length, 32);
  assert.deepEqual(questionIdFor(coin, "42"), id);
  assert.notDeepEqual(questionIdFor(coin, "43"), id);
  assert.notDeepEqual(questionIdFor(other, "42"), id);
});

test("only the predictions engine's ids make a question id", () => {
  assert.ok(isPredictionId("1") && isPredictionId("999999999"));
  for (const bad of ["", "0", "01", "1234567890", "-1", "1.5", "42 "]) {
    assert.throws(() => questionIdFor(coin, bad), /Not a prediction id/, bad);
  }
});

test("payout numerators: YES wins, NO wins, refund splits evenly", () => {
  assert.deepEqual(payoutNumerators("yes"), [1, 0]);
  assert.deepEqual(payoutNumerators("no"), [0, 1]);
  assert.deepEqual(payoutNumerators("refund"), [1, 1]);
});

test("redemption pays winners 1 SOL per token, losers 0, and half each on a refund", () => {
  const tokens = BigInt(3_000_000_000);
  assert.equal(redeemLamports(tokens, "yes", payoutNumerators("yes")), tokens);
  assert.equal(redeemLamports(tokens, "no", payoutNumerators("yes")), BigInt(0));
  assert.equal(redeemLamports(tokens, "no", payoutNumerators("no")), tokens);
  assert.equal(redeemLamports(tokens, "yes", payoutNumerators("refund")), BigInt(1_500_000_000));
  assert.equal(redeemLamports(BigInt(3), "yes", payoutNumerators("refund")), BigInt(1), "rounds down, like the program");
  assert.throws(() => redeemLamports(tokens, "yes", [0, 0]), /all be zero/);
});

test("price from a Q64 sqrt price: 0.5 at the start, 1 at the top", () => {
  const q64 = BigInt(1) << BigInt(64);
  assert.equal(priceFromSqrtPrice(q64), 1);
  // sqrt(0.5) * 2^64, as the DAMM v2 SDK computes it for a 0.5 price
  assert.ok(Math.abs(priceFromSqrtPrice(BigInt("13043817825332782212")) - 0.5) < 1e-9);
  assert.ok(Math.abs(priceFromSqrtPrice(q64 / BigInt(10)) - 0.01) < 1e-9);
});

test("odds: prices scaled so the two sides sum to 1", () => {
  const odds = oddsFromPrices(0.6, 0.3);
  assert.deepEqual(odds.priceSol, { yes: 0.6, no: 0.3 });
  assert.ok(Math.abs(odds.probability.yes - 2 / 3) < 1e-12);
  assert.ok(Math.abs(odds.probability.yes + odds.probability.no - 1) < 1e-12);
  assert.deepEqual(oddsFromPrices(0.5, 0.5).probability, { yes: 0.5, no: 0.5 });
  assert.throws(() => oddsFromPrices(0, 0), /zero/);
});
