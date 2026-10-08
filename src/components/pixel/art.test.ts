import assert from "node:assert/strict";
import { test } from "node:test";
import { seededRandom, seedFrom } from "./art";

// A coin's pictures are drawn from these numbers, so a change here redraws every coin.
test("the same seed always gives the same sequence", () => {
  const random = seededRandom(42);
  assert.equal(random(), 0.00032870750889587566);
  assert.equal(random(), 0.5245871020129822);
});

test("zero and negative or fractional seeds still give a usable generator", () => {
  assert.equal(seededRandom(0)(), 0.000007826369259425611);
  assert.equal(seededRandom(-3.7)(), 0.000031305477037702444);
});

test("a mint address gives a stable seed", () => {
  assert.equal(seedFrom("Ebt5dA6zkvrin1jr4nvGdU5BbEC6BwV5pPVggs3Tcg9B"), 1808879813);
});
