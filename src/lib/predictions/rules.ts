/**
 * Predictions: free points only. No money, no SOL, no tokens, no prizes. Every wallet gets a
 * one-time grant when it first signs in; points can never be bought, sold or sent to another
 * wallet. Pure rules and numbers shared by the server, the browser and the tests.
 */

export type Side = "yes" | "no";
/** cancel: every bet is refunded. */
export type Outcome = Side | "cancel";

export const MINUTE_MS = 60_000;

/** A wallet's one-time grant on its first sign-in (at most MAX_GRANTS_PER_IP wallets per IP a day). */
export const GRANT_POINTS = 1_000;
/** The streamer's page beats once a minute while open (it marks "streamer here"); beats closer than 50 s are ignored. */
export const HEARTBEAT_MS = MINUTE_MS;
export const MIN_HEARTBEAT_GAP_MS = 50_000;

/** Suggestions: 5 to 80 characters, cost 10 points (back when it goes live), expire after 20 minutes. */
export const SUGGEST_COST = 10;
export const SUGGEST_TTL_MS = 20 * MINUTE_MS;
export const QUESTION_MIN = 5;
export const QUESTION_MAX = 80;
/**
 * AI review: every typed question waits "under review" until jev approves it. A failed check is
 * tried again at most this often, this many times; then the streamer or a mod decides by hand.
 */
export const REVIEW_RETRY_MS = 5_000;
export const REVIEW_MAX_TRIES = 5;
/**
 * AI check of a YES/NO result (the referee's runs use the same pause and limit): a vision model
 * describes stream frames, jev decides what happened. A check of a result someone else resolved never
 * changes payouts. A run that fails is tried again after this pause, at most this many runs in all
 * (the first plus two retries); then it "couldn't tell". A claimed run holds a lease of
 * AI_RUN_LEASE_MS, longer than a whole run (a frame, a description and jev, each with its timeout
 * and busy retries), so no other server starts the same run meanwhile; a run that failed gives the
 * lease back and the next may start after the pause. An answer from an older run never counts.
 */
export const AI_CHECK_RETRY_MS = 20_000;
export const AI_RUN_LEASE_MS = 2 * MINUTE_MS;
export const AI_CHECK_MAX_TRIES = 3;
/** Hard deadline: past this long after the result's flag window, an unfinished AI check ends as "couldn't tell", whatever the server's keys. */
export const AI_CHECK_MAX_WAIT_MS = 5 * 60_000;
/**
 * The AI referee: it decides a prediction first; if it can't, the streamer (or a mod) decides.
 * While a prediction runs, and for FRAMES_AFTER_LOCK_MS after betting closes, the server grabs the
 * stream's preview picture at most every FRAME_GAP_MS. Twitch renews that picture only about every
 * 5 minutes, so a picture seen before is not described again, and grabbing goes on past the lock to
 * catch the next one. At most MAX_FRAME_NOTES descriptions are kept (the first and the newest).
 */
export const FRAME_GAP_MS = 50_000;
export const FRAMES_AFTER_LOCK_MS = 6 * MINUTE_MS;
export const MAX_FRAME_NOTES = 12;
/**
 * A market (real SOL) needs MIN_MARKET_PICTURES distinct pictures taken after the lock that agree
 * before an AI result counts, so grabbing goes on longer: two preview refreshes.
 */
export const MARKET_FRAMES_AFTER_LOCK_MS = 11 * MINUTE_MS;
export const MIN_MARKET_PICTURES = 2;
/** With no YES or NO from the referee this long after its frame window, it "couldn't tell": the streamer decides. */
export const REFEREE_GRACE_MS = 4 * MINUTE_MS;
/** The referee's check rule (what on stream decides YES or NO, only a hint), written once the question goes live. */
export const CHECK_RULE_MAX = 200;
/** The referee's short reason (what it saw), shown under its result. */
export const REFEREE_REASON_MAX = 160;
/**
 * On-chain markets (MEMESTREAM_MARKETS): claiming a market's server steps (create, close trading,
 * resolve) holds them this long, longer than a whole run can take (a create sends up to four
 * transactions, each waiting up to 60 s to confirm), so no other server re-runs a step still in
 * flight. A run that failed gives its claim back early: the steps are tried again after
 * MARKET_FAILED_RETRY_MS. A server that died mid-run frees them when the claim runs out. Creating
 * gives up after MARKET_CREATE_MAX_TRIES ("Market unavailable"; points bets stay open); closing and
 * resolving keep trying.
 */
export const MARKET_RETRY_MS = 5 * 60_000;
export const MARKET_FAILED_RETRY_MS = 30_000;
export const MARKET_CREATE_MAX_TRIES = 3;
/**
 * Challenge window (UMA style), markets only: a YES, NO or cancel (the AI referee's, the streamer's
 * or an admin's) is only proposed; it goes on chain this long after, unless a holder challenges it with a points bond. An admin
 * (MEMESTREAM_ADMIN_WALLETS, never the coin's streamer) then decides the outcome; the bond is lost
 * if the proposal stands, comes back on a refund, and comes back plus a reward if the other side
 * wins. Markets nobody resolved, or where the AI check disagreed, also wait for an admin. No
 * decision within MARKET_DECISION_MS: void (refund) as a last resort.
 */
export const MARKET_CHALLENGE_MS = 2 * 60 * MINUTE_MS;
export const MARKET_DECISION_MS = 24 * 60 * MINUTE_MS;
export const CHALLENGE_BOND = 100;
export const OVERTURN_REWARD = 50;
export const CHALLENGE_REASON_MAX = 200;
/** A streamer's or mod's witness note (what the stream showed) is cut to this many characters. */
export const WITNESS_NOTE_MAX = 200;
export const CHALLENGE_REASON_MIN = 5;
/** Links (a market's official source, a challenge's evidence) are kept this short. */
export const LINK_MAX = 200;
/** A frame description is cut to this many characters. */
export const FRAME_NOTE_MAX = 400;
/** A "wasn't approved" note shows to its asker for this long. */
export const NOTICE_MS = 5 * MINUTE_MS;
/** A suggestion goes live by itself with this many eligible upvotes, while a live slot is free. */
export const AUTO_LAUNCH_UPVOTES = 3;

/** Up to MAX_LIVE live predictions at a time per coin, at most 20 over a stream's life. */
export const MAX_LIVE = 10;
export const MAX_PREDICTIONS_PER_STREAM = 20;
/** Betting windows the AI review picks from; without its pick, DEFAULT_WINDOW_MIN. */
export const BET_WINDOWS_MIN = [1, 2, 5, 10, 30, 60] as const;
export const DEFAULT_WINDOW_MIN = 2;
export const isBetWindow = (minutes: unknown): minutes is number => (BET_WINDOWS_MIN as readonly unknown[]).includes(minutes);
/** Bets: 10 to 1,000 points, and never more than half the wallet's balance. */
export const MIN_BET = 10;
export const MAX_BET = 1_000;
/** A locked prediction nobody resolves within this long cancels by itself (full refunds). */
export const AUTO_CANCEL_MS = 60 * MINUTE_MS;
/** The asker earns this when their question resolves YES or NO with enough eligible bettors. */
export const ASKER_REWARD = 50;
export const ASKER_REWARD_MIN_BETTORS = 5;
/** A result is marked "disputed" once flags reach this percent of its bettors. */
export const DISPUTE_PERCENT = 30;
/** The streamer may add a few mod wallets. */
export const MAX_MODS = 5;

/** A crowd-launched prediction cancels sooner if nobody resolves it (the streamer may have left). */
export const AUTO_CANCEL_CROWD_MS = 15 * MINUTE_MS;
/** The crowd launches questions only while the streamer's own heartbeat on the coin is this recent. */
export const STREAMER_PRESENT_MS = 5 * MINUTE_MS;
/** A new stream starts when the streamer comes back after this long away: the 20 and the stream leaderboard reset. */
export const STREAM_GAP_MS = 120 * MINUTE_MS;
/** After a result, bettors can flag it for this long; then it counts (leaderboard, asker reward) unless disputed. */
export const FLAG_WINDOW_MS = 10 * MINUTE_MS;
/**
 * Caps that keep each of a coin's game documents under about 256 KB, since every action and GET
 * reads them and every action rewrites them (doc-size.test.ts builds a game at full caps).
 * Waiting suggestions per coin.
 */
export const MAX_QUEUE = 25;
/** "Wasn't approved" notes kept per coin (the oldest goes first). */
export const MAX_NOTICES = 30;
/** Bettors per prediction. */
export const MAX_BETTORS = 200;
/** Upvoters kept in full per suggestion; beyond that, short fingerprints (for dedupe) up to MAX_UPVOTES. */
export const MAX_UPVOTERS_STORED = 20;
export const MAX_UPVOTES = 100;
/** Past results kept per coin, as summaries (results still in their flag window are kept too). */
export const MAX_HISTORY = 20;
/**
 * Settled markets kept past MAX_HISTORY, newest first: holders may come back much later to redeem,
 * and the app finds their market here. Each is a short summary (no per-bettor lists).
 */
export const MAX_MARKET_HISTORY = 50;
/** Per-stream leaderboard entries kept. */
export const MAX_WON_ENTRIES = 100;
/** A wallet holds the coin, for suggesting and upvoting, with at least this many whole coins (UI units, after the mint's decimals). */
export const MIN_HOLDING_COINS = 1;
/** `coins` is a balance in UI units, e.g. "0.000001" or "1.5". */
export const holdsEnough = (coins: string | null | undefined) => Number(coins ?? 0) >= MIN_HOLDING_COINS;
/** Distinct wallets that may get the sign-in grant from one IP per UTC day (the anti-farm rule). */
export const MAX_GRANTS_PER_IP = 5;

/** Leaderboard order: points high to low; ties by wallet, high to low (the same as Redis ZREVRANGE). */
export const byPoints = (a: { wallet: string; points: number }, b: { wallet: string; points: number }) =>
  b.points - a.points || (a.wallet < b.wallet ? 1 : a.wallet > b.wallet ? -1 : 0);

export const isSide = (value: unknown): value is Side => value === "yes" || value === "no";
export const isOutcome = (value: unknown): value is Outcome => isSide(value) || value === "cancel";

export type Bet = { wallet: string; side: Side; amount: number };

const ZERO = BigInt(0);
const sum = (bets: Bet[]) => bets.reduce((total, b) => total + BigInt(b.amount), ZERO);

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

/** What a winning point on `side` pays now (stake included), e.g. 2.4; null while either side is empty. */
export function multiplier(side: Side, pools: { yes: number; no: number }): number | null {
  const mine = pools[side];
  const other = side === "yes" ? pools.no : pools.yes;
  return mine > 0 && other > 0 ? (mine + other) / mine : null;
}

const URL_LIKE = /(https?:|www\.|:\/\/|\b[a-z0-9-]+\.(com|net|org|io|gg|tv|xyz|lol|app|me|co|fun|link|ly)\b)/i;
/** Invisible format characters: bidi overrides, zero-width joiners and the like. */
const FORMAT_CHARS = /\p{Cf}/u;
/** ASCII control characters, except tab, newline and carriage return (whitespace collapses them). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const HTML_BRACKETS = /[<>]/;
const PLAIN_TEXT_ONLY = "Plain text only";

/**
 * Cleans a question: NFKC-normalizes (so fullwidth or styled letters can't dodge the link check),
 * refuses invisible format characters (bidi overrides, zero-width), trims, collapses whitespace;
 * 5 to 80 characters, plain text, no links.
 */
export function cleanQuestion(text: unknown): { ok: true; question: string } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "Type a question" };
  const normalized = text.normalize("NFKC");
  if (FORMAT_CHARS.test(normalized) || CONTROL_CHARS.test(normalized)) return { ok: false, error: PLAIN_TEXT_ONLY };
  const question = normalized.replace(/\s+/g, " ").trim();
  if (question.length < QUESTION_MIN || question.length > QUESTION_MAX) {
    return { ok: false, error: `Questions are ${QUESTION_MIN} to ${QUESTION_MAX} characters` };
  }
  if (URL_LIKE.test(question)) return { ok: false, error: "No links in questions" };
  if (HTML_BRACKETS.test(question)) return { ok: false, error: PLAIN_TEXT_ONLY };
  return { ok: true, question };
}

/** A challenge's reason: plain text, one line, CHALLENGE_REASON_MIN to CHALLENGE_REASON_MAX characters. */
export function cleanReason(text: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "Say why the result is wrong" };
  const normalized = text.normalize("NFKC");
  if (FORMAT_CHARS.test(normalized) || CONTROL_CHARS.test(normalized) || HTML_BRACKETS.test(normalized)) return { ok: false, error: PLAIN_TEXT_ONLY };
  const reason = normalized.replace(/\s+/g, " ").trim();
  if (reason.length < CHALLENGE_REASON_MIN || reason.length > CHALLENGE_REASON_MAX) {
    return { ok: false, error: `Reasons are ${CHALLENGE_REASON_MIN} to ${CHALLENGE_REASON_MAX} characters` };
  }
  return { ok: true, reason };
}

/** An http(s) link of at most LINK_MAX characters, normalized; null if it isn't one. */
export function cleanLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > LINK_MAX) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    const href = url.href;
    return href.length <= LINK_MAX ? href : null;
  } catch {
    return null;
  }
}
