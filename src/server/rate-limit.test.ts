import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyedLimiter, TokenBucket } from "./rate-limit";

test("a bucket allows a burst, then refills over time", () => {
  const bucket = new TokenBucket(3, 1, 0);
  assert.ok(bucket.take(1, 0) && bucket.take(1, 0) && bucket.take(1, 0));
  assert.equal(bucket.take(1, 0), false);
  assert.ok(bucket.take(1, 1_000)); // one token back after a second
});

test("keys are limited separately", () => {
  const limiter = new KeyedLimiter(1, 0.001);
  assert.ok(limiter.take("a", 0));
  assert.equal(limiter.take("a", 0), false);
  assert.ok(limiter.take("b", 0));
});
