import assert from "node:assert/strict";
import { test } from "node:test";
import { GRANT_POINTS } from "./rules";
import { grant, isEligible, newProfile, onLeaderboard, utcDay } from "./watch";

test("the sign-in grant comes once, and only when the IP may still get one", () => {
  const first = grant(newProfile(), true);
  assert.deepEqual(first, { profile: { granted: true }, points: GRANT_POINTS });
  assert.deepEqual(grant(first.profile, true).points, 0, "never twice");
  assert.deepEqual(grant(newProfile(), false), { profile: { granted: false }, points: 0 }, "over the per-IP cap: no grant, it can come on a later sign-in");
});

test("granted wallets are eligible and on leaderboards; others aren't", () => {
  assert.equal(isEligible(newProfile()), false);
  assert.equal(onLeaderboard(null), false);
  assert.equal(isEligible({ granted: true }), true);
  assert.equal(onLeaderboard({ granted: true }), true);
});

test("utcDay names the UTC day", () => {
  assert.equal(utcDay(Date.parse("2026-10-12T23:59:59Z")), "2026-10-12");
  assert.equal(utcDay(Date.parse("2026-10-13T00:00:00Z")), "2026-10-13");
});
