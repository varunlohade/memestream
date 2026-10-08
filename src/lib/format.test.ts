import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, compact, fractionOf, minusReserve, percentChange, signedPercent } from "./format";

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

test("percent and time", () => {
  assert.equal(percentChange(0, 5), null);
  assert.equal(signedPercent(percentChange(10, 13.82) ?? 0), "+38.2%");
  assert.equal(ago(1000, 1_004_000), "4s");
  assert.equal(ago(0, 7_200_000), "2h");
  assert.equal(ago(null), "-");
});

test("exact fractions and reserves for amount chips", () => {
  assert.equal(fractionOf("116808735.448833", 25, 6), "29202183.862208");
  assert.equal(fractionOf("10.5", 50, 6), "5.25");
  assert.equal(fractionOf("0.000001", 50, 6), "0");
  assert.equal(minusReserve("1.5", "0.01", 9), "1.49");
  assert.equal(minusReserve("0.005", "0.01", 9), "0");
});
