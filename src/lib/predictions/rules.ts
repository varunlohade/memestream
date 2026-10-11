/**
 * Predictions: free points only. No money, no SOL, no tokens, no prizes. Points come from watching
 * streams; they can never be bought, sold or sent to another wallet. Pure rules and numbers shared
 * by the server, the browser and the tests.
 */

export type Side = "yes" | "no";
/** cancel: every bet is refunded. */
export type Outcome = Side | "cancel";

const MINUTE = 60_000;

/** Watching: +2 points per minute, at most 600 a day; heartbeats closer than 50 s apart earn nothing. */
export const POINTS_PER_MINUTE = 2;
export const DAILY_WATCH_CAP = 600;
export const HEARTBEAT_MS = MINUTE;
export const MIN_HEARTBEAT_GAP_MS = 50_000;
/** A one-time starter grant, unlocked after 10 minutes of watching. */
export const STARTER_POINTS = 200;
export const STARTER_AFTER_MS = 10 * MINUTE;
/** Watch time (any coin) a wallet needs before its upvotes and bets count as "eligible". */
export const ELIGIBLE_AFTER_MS = 15 * MINUTE;
/** Watch time a wallet needs to appear on a leaderboard. */
export const LEADERBOARD_AFTER_MS = 30 * MINUTE;

/** Suggestions: 5 to 80 characters, cost 10 points (back when it goes live), expire after 20 minutes. */
export const SUGGEST_COST = 10;
export const SUGGEST_TTL_MS = 20 * MINUTE;
export const QUESTION_MIN = 5;
export const QUESTION_MAX = 80;
/** A suggestion goes live by itself with this many eligible upvotes, when nothing is live. */
export const AUTO_LAUNCH_UPVOTES = 3;

/** One live prediction at a time per coin, at most 20 over a stream's life. */
export const MAX_PREDICTIONS_PER_STREAM = 20;
export const BET_WINDOWS_MIN = [1, 2, 5, 10] as const;
export const DEFAULT_WINDOW_MIN = 2;
/** Bets: 10 to 1,000 points, and never more than half the wallet's balance. */
export const MIN_BET = 10;
export const MAX_BET = 1_000;
/** A locked prediction nobody resolves within this long cancels by itself (full refunds). */
export const AUTO_CANCEL_MS = 60 * MINUTE;
/** The asker earns this when their question resolves YES or NO with enough eligible bettors. */
export const ASKER_REWARD = 50;
export const ASKER_REWARD_MIN_BETTORS = 5;
/** A result is marked "disputed" once flags reach this percent of its bettors. */
export const DISPUTE_PERCENT = 30;
/** The streamer may add a few mod wallets. */
export const MAX_MODS = 5;

/** A crowd-launched prediction cancels sooner if nobody resolves it (the streamer may have left). */
export const AUTO_CANCEL_CROWD_MS = 15 * MINUTE;
/** The crowd launches questions only while the streamer's own heartbeat on the coin is this recent. */
export const STREAMER_PRESENT_MS = 5 * MINUTE;
/** After a result, bettors can flag it for this long; then it counts (leaderboard, asker reward) unless disputed. */
export const FLAG_WINDOW_MS = 10 * MINUTE;
/**
 * Caps that keep a coin's whole game document under about 256 KB, since every action and GET
 * reads it and every action rewrites it (doc-size.test.ts builds one at full caps).
 * Waiting suggestions per coin.
 */
export const MAX_QUEUE = 25;
/** Bettors per prediction. */
export const MAX_BETTORS = 200;
/** Upvoters kept in full per suggestion; beyond that, short fingerprints (for dedupe) up to MAX_UPVOTES. */
export const MAX_UPVOTERS_STORED = 20;
export const MAX_UPVOTES = 100;
/** Past results kept per coin, as summaries (results still in their flag window are kept too). */
export const MAX_HISTORY = 20;
/** Per-stream leaderboard entries kept. */
export const MAX_WON_ENTRIES = 100;
/** Distinct wallets that may earn watch points from one IP per UTC day. */
export const MAX_EARNING_WALLETS_PER_IP = 5;

/** Leaderboard order: points high to low; ties by wallet, high to low (the same as Redis ZREVRANGE). */
export const byPoints = (a: { wallet: string; points: number }, b: { wallet: string; points: number }) =>
  b.points - a.points || (a.wallet < b.wallet ? 1 : a.wallet > b.wallet ? -1 : 0);

export const isSide = (value: unknown): value is Side => value === "yes" || value === "no";
export const isOutcome = (value: unknown): value is Outcome => isSide(value) || value === "cancel";

export type Bet = { wallet: string; side: Side; amount: number };

/**
 * Parimutuel payout, in whole points, no house fee. Winners get their stake back plus a pro-rata
 * share of the losing pool, rounded down; the points left over by rounding go to the largest
 * winning stake (ties: lower wallet address), so the total paid always equals the total staked.
 * Cancel, or an empty side: everyone gets their stake back.
 */
export function payouts(bets: Bet[], outcome: Outcome): Map<string, number> {
  const result = new Map<string, number>();
  for (const b of bets) result.set(b.wallet, 0);
  const winners = bets.filter((b) => b.side === outcome && b.amount > 0);
  const winPool = sum(winners);
  const losePool = sum(bets) - winPool;
  if (outcome === "cancel" || winPool === ZERO || losePool === ZERO) {
    for (const b of bets) result.set(b.wallet, b.amount);
    return result;
  }
  let leftover = losePool;
  for (const b of winners) {
    const share = (BigInt(b.amount) * losePool) / winPool;
    leftover -= share;
    result.set(b.wallet, b.amount + Number(share));
  }
  const largest = winners.reduce((best, b) => (b.amount > best.amount || (b.amount === best.amount && b.wallet < best.wallet) ? b : best));
  result.set(largest.wallet, result.get(largest.wallet)! + Number(leftover));
  return result;
}

const ZERO = BigInt(0);
const sum = (bets: Bet[]) => bets.reduce((total, b) => total + BigInt(b.amount), ZERO);

/** What a winning point on `side` pays now (stake included), e.g. 2.4; null while either side is empty. */
export function multiplier(side: Side, pools: { yes: number; no: number }): number | null {
  const mine = pools[side];
  const other = side === "yes" ? pools.no : pools.yes;
  return mine > 0 && other > 0 ? (mine + other) / mine : null;
}

const URL_LIKE = /(https?:|www\.|:\/\/|\b[a-z0-9-]+\.(com|net|org|io|gg|tv|xyz|lol|app|me|co|fun|link|ly)\b)/i;

/** Cleans a question: trims, collapses whitespace; 5 to 80 characters, plain text, no links. */
export function cleanQuestion(text: unknown): { ok: true; question: string } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "Type a question" };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { ok: false, error: "Plain text only" };
  const question = text.replace(/\s+/g, " ").trim();
  if (question.length < QUESTION_MIN || question.length > QUESTION_MAX) {
    return { ok: false, error: `Questions are ${QUESTION_MIN} to ${QUESTION_MAX} characters` };
  }
  if (URL_LIKE.test(question)) return { ok: false, error: "No links in questions" };
  if (/[<>]/.test(question)) return { ok: false, error: "Plain text only" };
  return { ok: true, question };
}
