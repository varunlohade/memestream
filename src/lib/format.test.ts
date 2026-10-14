import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, atMost, compact, formatSol, fractionOf, isOver, minusReserve, percentChange, shortAddress, signedPercent } from "./format";

test("compact numbers", () => {
  assert.equal(compact(42100), "42.1K");
  assert.equal(compact(3.2), "3.2");
  assert.equal(compact(85), "85");
  assert.equal(compact(0), "0");
  assert.equal(compact(0.000012), "0.000012");
  assert.equal(compact(0.000000003), "<0.000001");
  assert.equal(compact(0.5), "0.5");
  assert.equal(compact(0.792188), "0.792");
  assert.equal(compact(Number.NaN), "-");
});

test("compact switches unit exactly at each power of a thousand", () => {
  assert.equal(compact(999), "999");
  assert.equal(compact(1_000), "1.0K");
  assert.equal(compact(1_000_000), "1.0M");
  assert.equal(compact(1_000_000_000), "1.0B");
  assert.equal(compact(-42100), "-42.1K");
});

test("SOL amounts accept decimal strings", () => {
  assert.equal(formatSol("12.3456789"), "12.35");
  assert.equal(formatSol(0), "0");
});

test("percent change needs a positive start", () => {
  assert.equal(percentChange(0, 5), null);
  assert.equal(signedPercent(percentChange(10, 13.82) ?? 0), "+38.2%");
  assert.equal(signedPercent(percentChange(10, 5) ?? 0), "-50.0%");
});

test("time ago in the largest whole unit", () => {
  assert.equal(ago(1000, 1_004_000), "4s");
  assert.equal(ago(0, 59_000), "59s");
  assert.equal(ago(0, 60_000), "1m");
  assert.equal(ago(0, 7_200_000), "2h");
  assert.equal(ago(0, 86_400_000), "1d");
  assert.equal(ago(10, 0), "0s", "a time in the future reads as now");
  assert.equal(ago(null), "-");
});

test("exact fractions for amount chips, rounded down", () => {
  assert.equal(fractionOf("116808735.448833", 25, 6), "29202183.862208");
  assert.equal(fractionOf("10.5", 50, 6), "5.25");
  assert.equal(fractionOf("0.000001", 50, 6), "0");
});

test("a reserve is kept back, floored at zero", () => {
  assert.equal(minusReserve("1.5", "0.01", 9), "1.49");
  assert.equal(minusReserve("0.01", "0.01", 9), "0");
  assert.equal(minusReserve("0.005", "0.01", 9), "0");
});

test("short addresses are the first six characters", () => {
  assert.equal(shortAddress("Ebt5dA6zkvrin1jr4nvGdU5BbEC6BwV5pPVggs3Tcg9B"), "Ebt5dA");
});

test("buy limits compare exact decimal strings", () => {
  assert.ok(isOver("0.5", "0.1", 9));
  assert.ok(isOver("0.100000001", "0.1", 9));
  assert.ok(!isOver("0.1", "0.1", 9));
  assert.ok(!isOver("0.09", "0.1", 9));
  assert.ok(!isOver("", "0.1", 9));
  assert.equal(atMost("2.5", "0.1", 9), "0.1");
  assert.equal(atMost("0.04", "0.1", 9), "0.04");
});
