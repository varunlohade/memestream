import assert from "node:assert/strict";
import { test } from "node:test";
import { LAUNCH_FEE, launchFeeAt } from "./launch-fee";

test("the launch fee falls from 50% to the 1% base over the first minute, one step per second", () => {
  assert.deepEqual(launchFeeAt(0), { bps: 5_000, secondsLeft: 60 });
  assert.deepEqual(launchFeeAt(0.9), { bps: 5_000, secondsLeft: 60 });
  assert.deepEqual(launchFeeAt(30), { bps: 2_550, secondsLeft: 30 }); // halfway: 50% - 49% * 30/60
  assert.deepEqual(launchFeeAt(59), { bps: 5_000 - (4_900 * 59) / 60, secondsLeft: 1 });
  assert.deepEqual(launchFeeAt(60), { bps: LAUNCH_FEE.endingFeeBps, secondsLeft: 0 });
  assert.deepEqual(launchFeeAt(5_000), { bps: 100, secondsLeft: 0 });
  assert.deepEqual(launchFeeAt(-3), { bps: 5_000, secondsLeft: 60 }, "clock skew before launch reads as launch");
});
