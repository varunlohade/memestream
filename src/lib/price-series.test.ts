import assert from "node:assert/strict";
import { test } from "node:test";
import type { TradeView } from "./api-types";
import { formatPrice, priceSeries } from "./price-series";

const trade = (time: number | null, priceSol: number, signature = `s${time}-${priceSol}`): TradeView => ({
  signature,
  side: "buy",
  sol: "0.1",
  coins: "1000",
  wallet: "w",
  time,
  priceSol,
  byStreamer: false,
});

test("trades become points sorted oldest first, whatever order they arrive in", () => {
  const points = priceSeries([trade(300, 3e-8), trade(100, 1e-8), trade(200, 2e-8)]);
  assert.deepEqual(points, [
    { time: 100, value: 1e-8 },
    { time: 200, value: 2e-8 },
    { time: 300, value: 3e-8 },
  ]);
});

test("trades in the same second merge into one point at the later trade's price", () => {
  // API order is newest first: the 2e-8 trade came after the 1e-8 trade in that second.
  const points = priceSeries([trade(200, 5e-8), trade(100, 2e-8), trade(100, 1e-8)]);
  assert.deepEqual(points, [
    { time: 100, value: 2e-8 },
    { time: 200, value: 5e-8 },
  ]);
  for (let i = 1; i < points.length; i++) assert.ok(points[i].time > points[i - 1].time);
});

test("the point value is the trade's SOL-per-coin price, unchanged", () => {
  assert.deepEqual(priceSeries([trade(1_700_000_000, 0.000000028123)]), [{ time: 1_700_000_000, value: 0.000000028123 }]);
});

test("trades without a time or a usable price are left out", () => {
  assert.deepEqual(priceSeries([trade(null, 1e-8), trade(100, 0), trade(101, Number.NaN), trade(102, 4e-8)]), [{ time: 102, value: 4e-8 }]);
  assert.deepEqual(priceSeries([]), []);
});

test("formatPrice keeps tiny SOL prices readable", () => {
  assert.equal(formatPrice(0.000000028123), "0.0₇281");
  assert.equal(formatPrice(0.0000123), "0.0₄123");
  assert.equal(formatPrice(0.0412), "0.0412");
  assert.equal(formatPrice(0.0999999), "0.1");
  assert.equal(formatPrice(0.99999), "1");
  assert.equal(formatPrice(12.3456), "12.35");
  assert.equal(formatPrice(0), "0");
});
