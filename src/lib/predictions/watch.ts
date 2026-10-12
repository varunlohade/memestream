/**
 * Points from watching. The coin page sends a heartbeat every 60 s while it is visible. Each
 * accepted heartbeat counts as one minute watched and earns 2 points, at most 600 points a UTC day.
 * Heartbeats closer than 50 s to the last accepted one earn nothing (so extra tabs don't pay).
 * After 10 minutes watched, a one-time starter grant of 200 points unlocks.
 */
import { DAILY_WATCH_CAP, ELIGIBLE_AFTER_MS, HEARTBEAT_MS, LEADERBOARD_AFTER_MS, MIN_HEARTBEAT_GAP_MS, POINTS_PER_MINUTE, STARTER_AFTER_MS, STARTER_POINTS } from "./rules";

/**
 * One wallet's watch record, shared by every coin. `earningMs` is the part of `watchMs` watched
 * while earning (not over the per-IP cap); only it counts toward eligibility.
 */
export type Profile = { watchMs: number; earningMs: number; starter: boolean; day: string; dayEarned: number; lastBeatAt: number | null };

export const newProfile = (): Profile => ({ watchMs: 0, earningMs: 0, starter: false, day: "", dayEarned: 0, lastBeatAt: null });

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One heartbeat at `now`. With `earning` false (too many wallets from one IP today) the minute
 * still counts as watched, but earns no points, doesn't unlock the starter grant and doesn't count
 * toward eligibility (so extra wallets from one IP can't cheaply upvote).
 */
export function heartbeat(profile: Profile, now: number, earning = true, starterAfterMs = STARTER_AFTER_MS): { profile: Profile; points: number; accepted: boolean } {
  if (profile.lastBeatAt !== null && now - profile.lastBeatAt < MIN_HEARTBEAT_GAP_MS) return { profile, points: 0, accepted: false };
  const day = utcDay(now);
  const next: Profile = { ...profile, lastBeatAt: now, watchMs: profile.watchMs + HEARTBEAT_MS, day, dayEarned: day === profile.day ? profile.dayEarned : 0 };
  if (!earning) return { profile: next, points: 0, accepted: true };
  next.earningMs = (profile.earningMs ?? 0) + HEARTBEAT_MS;
  let points = Math.max(0, Math.min(POINTS_PER_MINUTE, DAILY_WATCH_CAP - next.dayEarned));
  next.dayEarned += points;
  if (!next.starter && next.watchMs >= starterAfterMs) {
    next.starter = true;
    points += STARTER_POINTS;
  }
  return { profile: next, points, accepted: true };
}

/** Enough earning watch time for upvotes and bets to count as "eligible". */
export const isEligible = (profile: Profile | null, afterMs = ELIGIBLE_AFTER_MS) => (profile?.earningMs ?? 0) >= afterMs;
/** Enough watch time to appear on a leaderboard. */
export const onLeaderboard = (profile: Profile | null) => (profile?.watchMs ?? 0) >= LEADERBOARD_AFTER_MS;
