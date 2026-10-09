/** What the predictions API returns for a coin (shared by the server and the browser; types only). */
import type { Outcome, Side } from "./rules";

export type LeaderRow = { wallet: string; points: number };
export type Standing = { points: number; rank: number | null };

export type PredictionsView = {
  /** Server time (ms), so countdowns don't depend on the viewer's clock. */
  now: number;
  launched: number;
  maxPerStream: number;
  me: {
    wallet: string;
    balance: number;
    watchMinutes: number;
    eligible: boolean;
    /** Minutes left until the starter grant, or null once it is unlocked. */
    starterInMinutes: number | null;
    role: "streamer" | "mod" | null;
    hasSuggestion: boolean;
  } | null;
  live: {
    id: string;
    text: string;
    launchedAt: number;
    lockAt: number;
    autoCancelAt: number;
    yes: number;
    no: number;
    bettors: number;
    myBet: { side: Side; amount: number } | null;
  } | null;
  queue: { id: string; text: string; upvotes: number; expiresAt: number; mine: boolean; upvoted: boolean }[];
  resolved: {
    id: string;
    text: string;
    outcome: Outcome;
    resolvedAt: number;
    resolvedBy: { role: "streamer" | "mod" | "auto"; wallet: string | null };
    disputed: boolean;
    my: { side: Side; bet: number; payout: number; flagged: boolean } | null;
  }[];
  mods: string[];
  leaderboard: { stream: LeaderRow[]; allTime: LeaderRow[]; me: { stream: Standing | null; allTime: Standing | null } };
};

export type Session = { wallet: string; token: string; expiresAt: number };
