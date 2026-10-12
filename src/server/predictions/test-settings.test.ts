import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PREFIX, REAL_WAITS, testSettings } from "./test-settings";

const TEST_ENV = { MEMESTREAM_PREDICTIONS_PREFIX: "memestream:pm-e2e:run1:", MEMESTREAM_PREDICTIONS_FAST: "1" };

test("production ignores the test prefix and the fast waits", () => {
  assert.deepEqual(testSettings({ ...TEST_ENV, VERCEL_ENV: "production" }), { prefix: DEFAULT_PREFIX, waits: REAL_WAITS });
});

test("outside production, the test prefix and the fast waits apply", () => {
  for (const VERCEL_ENV of [undefined, "preview", "development"]) {
    const settings = testSettings({ ...TEST_ENV, VERCEL_ENV });
    assert.equal(settings.prefix, "memestream:pm-e2e:run1:");
    assert.deepEqual(settings.waits, { starterAfterMs: 60_000, eligibleAfterMs: 120_000 });
  }
});

test("without the test settings, the defaults stay", () => {
  assert.deepEqual(testSettings({}), { prefix: DEFAULT_PREFIX, waits: REAL_WAITS });
  assert.equal(DEFAULT_PREFIX, "memestream:pm:");
  assert.deepEqual(REAL_WAITS, { starterAfterMs: 10 * 60_000, eligibleAfterMs: 15 * 60_000 });
});

test("MEMESTREAM_PREDICTIONS_STARTER_MIN shortens only the starter wait, in production too, within 1-10 minutes", () => {
  const prod = (v: string) => testSettings({ VERCEL_ENV: "production", MEMESTREAM_PREDICTIONS_STARTER_MIN: v }).waits;
  assert.deepEqual(prod("2"), { ...REAL_WAITS, starterAfterMs: 2 * 60_000 });
  for (const bad of ["0", "11", "1.5", "abc", ""]) assert.deepEqual(prod(bad), REAL_WAITS, bad);
  assert.equal(testSettings({ VERCEL_ENV: "production", MEMESTREAM_PREDICTIONS_STARTER_MIN: "2", MEMESTREAM_PREDICTIONS_PREFIX: "x:" }).prefix, "memestream:pm:");
});
