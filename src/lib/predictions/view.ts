/** What the predictions API returns for a coin (shared by the server and the browser; types only). */
import type { Outcome, Side } from "./rules";

export type LeaderRow = { wallet: string; points: number };
export type Standing = { points: number; rank: number | null };

export type PredictionsView = {
  /** Server time (ms), so countdowns don't depend on the viewer's clock. */
  now: number;
  launched: number;
  maxPerStream: number;
  /** The streamer's "Crowd picks questions" switch. */
  crowdPicks: boolean;
  /** The streamer's own heartbeat on this coin is recent: only then does the crowd launch questions. */
  streamerHere: boolean;
  me: {
    wallet: string;
    balance: number;
    watchMinutes: number;
    eligible: boolean;
    /** Minutes left until the starter grant, or null once it is unlocked. */
    starterInMinutes: number | null;
    role: "streamer" | "mod" | null;
    hasSuggestion: boolean;
    /** Holds at least 1 whole coin (needed to suggest and upvote); null if unknown or staff. */
    holder: boolean | null;
    /** A short "Not approved: ..." note about this wallet's question (staff: about a typed question), shown for a few minutes. */
    notice: string | null;
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
  /** The streamer's or a mod's typed question while it is under review (sent to staff only). */
  pending: { id: string; text: string; stuck: boolean } | null;
  /** Waiting suggestions this viewer can see; `queue` lists the top ones only. */
  queueSize: number;
  /**
   * "review": the AI review hasn't approved it yet. Only its asker sees it, and staff once `stuck`
   * (every check failed: staff approve or remove it by hand). It can't be upvoted or launched.
   */
  queue: { id: string; text: string; upvotes: number; expiresAt: number; mine: boolean; upvoted: boolean; status: "review" | "ok"; stuck: boolean }[];
  resolved: {
    id: string;
    text: string;
    outcome: Outcome;
    resolvedAt: number;
    /** `wallet` is sent to the streamer and mods only (null for everyone else, and for "auto"). */
    resolvedBy: { role: "streamer" | "mod" | "auto"; wallet: string | null };
    disputed: boolean;
    /** The AI check's second opinion: "checking" while it runs; null if no check ran. */
    ai: "checking" | "agree" | "disagree" | "unclear" | null;
    /** Flags are taken until then (ms); null once the result counts. */
    flagUntil: number | null;
    my: { bet: number; payout: number; flagged: boolean; canFlag: boolean } | null;
  }[];
  /** The coin's mods (sent to the streamer and mods only). */
  mods: string[];
  leaderboard: { stream: LeaderRow[]; allTime: LeaderRow[]; me: { stream: Standing | null; allTime: Standing | null } };
};

export type Session = { wallet: string; token: string; expiresAt: number };
