import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { COIN_DECIMALS, SOL_DECIMALS } from "../api-types";
import { BASE_DECIMALS, baseUnitsToCoins, coinsToBaseUnits, lamportsToSol, QUOTE, solToLamports, toBN } from "./units";

test("parses decimals exactly, without float error", () => {
  assert.equal(solToLamports("0.1").toString(), "100000000");
  assert.equal(solToLamports("1.1").toString(), "1100000000");
  assert.equal(solToLamports("85").toString(), "85000000000");
  assert.equal(coinsToBaseUnits("12.5").toString(), "12500000");
});

test("rejects bad input", () => {
  assert.throws(() => solToLamports("-1"), /positive decimal/);
  assert.throws(() => solToLamports("1e3"), /positive decimal/);
  assert.throws(() => solToLamports(""), /positive decimal/);
  assert.throws(() => coinsToBaseUnits("0.0000001"), /At most 6 decimal places/);
});

test("formats base units back to decimals", () => {
  assert.equal(lamportsToSol(new BN("1250000000")), "1.25");
  assert.equal(lamportsToSol(new BN(1)), "0.000000001");
  assert.equal(lamportsToSol(new BN(0)), "0");
  assert.equal(baseUnitsToCoins(new BN("28510000000")), "28510");
  assert.equal(lamportsToSol(solToLamports("0.123456789")), "0.123456789");
});

test("converts spl-token bigints", () => {
  assert.equal(toBN(BigInt("18446744073709551615")).toString(), "18446744073709551615");
});

test("the browser-safe decimals in api-types match the on-chain units", () => {
  assert.equal(SOL_DECIMALS, QUOTE.decimals);
  assert.equal(COIN_DECIMALS, BASE_DECIMALS);
});
