/** What the predictions API returns for a coin (shared by the server and the browser; types only). */
import type { RefereeWhy } from "./engine";
import type { Outcome, Side } from "./rules";

/**
 * A prediction's on-chain market (MEMESTREAM_MARKETS): "opening" until the oracle created it,
 * "failed" if it couldn't (the points bet stays), else open/closed/resolved. null: no market.
 */
export type MarketStepView = "opening" | "open" | "closed" | "resolved" | "failed" | null;

/**
 * Where a resolved prediction's market stands (markets only): "proposed" (the AI's, streamer's or admin's result,
 * final at `finalAt` unless challenged), "disputed" (challenged, or waiting for an admin because
 * nobody resolved it or the AI check disagreed), or "final" (`final` is what the market pays).
 */
export type MarketVerdictView = {
  status: "proposed" | "disputed" | "final";
  /** The streamer's proposal: a cancel proposes a refund. */
  proposed: Side | "refund";
  finalAt: number | null;
  final: Side | "refund" | null;
  /** Why it waits for an admin, for admins only ("fallback": the streamer decided because the AI couldn't tell). */
  why: "challenge" | "unresolved" | "fallback" | "ai" | null;
  /** Why the AI couldn't tell, when the streamer decided; for admins only. */
  aiWhy: RefereeWhy | null;
  /** The challenge, for admins only (null for everyone else). */
  challenge: { by: string; at: number; reason: string; link: string | null; bond: number } | null;
} | null;

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
    /** Got the sign-in grant: its bets count toward the asker reward, and it can be on leaderboards. */
    eligible: boolean;
    role: "streamer" | "mod" | null;
    hasSuggestion: boolean;
    /** Holds at least 1 whole coin (needed to suggest and upvote); null if unknown or staff. */
    holder: boolean | null;
    /** A short "Your question wasn't approved: ..." note about this wallet's question (staff: about a typed question), shown for a few minutes. */
    notice: string | null;
    /** A memestream admin (MEMESTREAM_ADMIN_WALLETS): settles market challenges. */
    admin: boolean;
  } | null;
  /** Live predictions, oldest first (at most MAX_LIVE). */
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
    market: MarketStepView;
    /** What the market resolves from: the streamer's official link, else null (the stream decides). */
    source: string | null;
    /** What the streamer or a mod says happened, once betting closed. */
    witness: WitnessView;
    /**
     * Once betting closed: "checking" while the AI referee decides; "unclear" when it couldn't tell
     * (or the coin has no AI): then the streamer or a mod decides. null while betting is open.
     */
    ai: "checking" | "unclear" | null;
    /** Why the AI couldn't tell, for admins only (null for everyone else, and while it checks). */
    aiWhy: RefereeWhy | null;
    /** What on stream decides YES or NO, as the AI wrote it once the question went live (a hint); null until then. */
    rule: string | null;
  }[];
  /** The streamer's or a mod's typed question while it is under review (sent to staff only). */
  pending: { id: string; text: string; stuck: boolean } | null;
  /** Waiting suggestions this viewer can see; `queue` lists the top ones only. */
  queueSize: number;
  /**
   * "review": the AI review hasn't approved it yet. Only its asker sees it, and staff once `stuck`
   * (every check failed: staff approve or remove it by hand). It can't be upvoted or launched.
   * `windowMin`: the betting window it gets when it goes live (the AI review's, else the default); null under review.
   */
  queue: { id: string; text: string; upvotes: number; expiresAt: number; mine: boolean; upvoted: boolean; status: "review" | "ok"; stuck: boolean; windowMin: number | null }[];
  resolved: {
    id: string;
    text: string;
    outcome: Outcome;
    resolvedAt: number;
    /** "ai": the AI referee; "admin": the memestream oracle. `wallet` is sent to the streamer and mods only (null for everyone else, and for "auto" and "ai"). */
    resolvedBy: { role: "ai" | "admin" | "streamer" | "mod" | "auto"; wallet: string | null };
    witness: WitnessView;
    disputed: boolean;
    /** The AI check's second opinion on a result someone else gave: "checking" while it runs; null if no check ran. */
    ai: "checking" | "agree" | "disagree" | "unclear" | null;
    /** What the AI referee saw, when it decided the result. */
    aiReason: string | null;
    /** Flags are taken until then (ms); null once the result counts. */
    flagUntil: number | null;
    my: { bet: number; payout: number; flagged: boolean; canFlag: boolean } | null;
    market: MarketStepView;
    source: string | null;
    /** When betting was open (ms), for "stream window HH:MM–HH:MM". */
    launchedAt: number | null;
    lockAt: number | null;
    verdict: MarketVerdictView;
  }[];
  /** The coin's mods (sent to the streamer and mods only). */
  mods: string[];
  /**
   * Settled markets older than the recent results (kept up to MAX_MARKET_HISTORY), so holders can
   * still find them and redeem.
   */
  pastMarkets: { id: string; text: string; outcome: Outcome; resolvedAt: number; source: string | null }[];
  leaderboard: { stream: LeaderRow[]; allTime: LeaderRow[]; me: { stream: Standing | null; allTime: Standing | null } };
};

/** The streamer's or a mod's account of what happened; null if none. */
export type WitnessView = { outcome: Side; note: string | null; role: "streamer" | "mod" } | null;

export type Session = { wallet: string; token: string; expiresAt: number };
