/**
 * A wallet's points record, shared by every coin: whether it got its one-time sign-in grant.
 * Granted wallets count as "eligible" (their bets count toward the asker reward) and appear on
 * leaderboards; the per-IP grant cap is what keeps one person from farming many wallets.
 */
import { GRANT_POINTS } from "./rules";

export type Profile = { granted: boolean };

export const newProfile = (): Profile => ({ granted: false });

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The sign-in grant: once per wallet, and only when its IP may still get grants today. */
export function grant(profile: Profile, allowed: boolean): { profile: Profile; points: number } {
  if (profile.granted || !allowed) return { profile, points: 0 };
  return { profile: { ...profile, granted: true }, points: GRANT_POINTS };
}

/** A wallet whose bets count toward the asker reward. */
export const isEligible = (profile: Profile | null) => profile?.granted === true;
/** A wallet that may appear on a leaderboard. */
export const onLeaderboard = (profile: Profile | null) => profile?.granted === true;
