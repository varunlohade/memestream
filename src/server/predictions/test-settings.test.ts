import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PREFIX, testSettings } from "./test-settings";

test("production ignores the test prefix and the short challenge window", () => {
  assert.deepEqual(testSettings({ MEMESTREAM_PREDICTIONS_PREFIX: "memestream:pm-e2e:run1:", MEMESTREAM_MARKET_CHALLENGE_MIN: "3", VERCEL_ENV: "production" }), { prefix: DEFAULT_PREFIX });
});

test("outside production, the test prefix applies", () => {
  for (const VERCEL_ENV of [undefined, "preview", "development"]) {
    assert.equal(testSettings({ MEMESTREAM_PREDICTIONS_PREFIX: "memestream:pm-e2e:run1:", VERCEL_ENV }).prefix, "memestream:pm-e2e:run1:");
  }
});

test("without the test settings, the defaults stay", () => {
  assert.deepEqual(testSettings({}), { prefix: DEFAULT_PREFIX });
  assert.equal(DEFAULT_PREFIX, "memestream:pm:");
});

test("MEMESTREAM_MARKET_CHALLENGE_MIN shortens the market challenge window outside production only, within 1-120 minutes", () => {
  assert.equal(testSettings({ MEMESTREAM_MARKET_CHALLENGE_MIN: "3" }).challengeMs, 3 * 60_000);
  for (const bad of ["0", "121", "1.5", "abc", ""]) assert.equal(testSettings({ MEMESTREAM_MARKET_CHALLENGE_MIN: bad }).challengeMs, undefined, bad);
});
