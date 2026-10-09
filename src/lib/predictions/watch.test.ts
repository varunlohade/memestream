import assert from "node:assert/strict";
import { test } from "node:test";
import { heartbeat, isEligible, newProfile, onLeaderboard, type Profile } from "./watch";

const MIN = 60_000;
const T0 = Date.parse("2026-10-09T00:00:00.000Z");

/** Beats every `gap` ms, `count` times; returns the profile and all points earned. */
function watch(count: number, gap = MIN, start = T0, from: Profile = newProfile()) {
  let profile = from;
  let points = 0;
  for (let i = 0; i < count; i++) {
    const beat = heartbeat(profile, start + i * gap);
    profile = beat.profile;
    points += beat.points;
  }
  return { profile, points };
}

test("each accepted heartbeat is one minute watched and 2 points", () => {
  const { profile, points } = watch(5);
  assert.equal(profile.watchMs, 5 * MIN);
  assert.equal(points, 10);
});

test("heartbeats closer than 50 s earn nothing and add no watch time", () => {
  const first = heartbeat(newProfile(), T0);
  const fast = heartbeat(first.profile, T0 + 49_999);
  assert.deepEqual([fast.accepted, fast.points], [false, 0]);
  assert.equal(fast.profile.watchMs, MIN);
  const ok = heartbeat(first.profile, T0 + 50_000);
  assert.deepEqual([ok.accepted, ok.points], [true, 2]);
  // Ten tabs beating every 6 s for 10 minutes: only one beat per 54 s counts (12 beats, at 0 s to 594 s).
  const tabs = watch(100, 6_000);
  assert.equal(tabs.profile.watchMs, 12 * MIN);
  assert.equal(tabs.points, 12 * 2 + 200);
});

test("the starter grant unlocks once, at 10 minutes watched", () => {
  const nine = watch(9);
  assert.equal(nine.points, 18);
  assert.equal(nine.profile.starter, false);
  const ten = heartbeat(nine.profile, T0 + 9 * MIN);
  assert.equal(ten.points, 2 + 200);
  const eleven = heartbeat(ten.profile, T0 + 10 * MIN);
  assert.equal(eleven.points, 2, "only once");
});

test("watching earns at most 600 points a UTC day, and the cap resets the next day", () => {
  const day = watch(400); // 400 minutes, inside one UTC day
  assert.equal(day.points, 600 + 200, "300 minutes reach the cap; plus the starter grant");
  assert.equal(day.profile.watchMs, 400 * MIN, "watch time still counts after the cap");
  const tomorrow = heartbeat(day.profile, Date.parse("2026-10-10T00:00:10.000Z"));
  assert.equal(tomorrow.points, 2);
});

test("eligibility: 15 minutes to upvote and bet as eligible, 30 for the leaderboard", () => {
  assert.equal(isEligible(watch(14).profile), false);
  assert.equal(isEligible(watch(15).profile), true);
  assert.equal(onLeaderboard(watch(29).profile), false);
  assert.equal(onLeaderboard(watch(30).profile), true);
  assert.equal(isEligible(null), false);
});
