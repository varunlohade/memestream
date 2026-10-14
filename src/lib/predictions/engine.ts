/**
 * One coin's predictions game, as pure functions: (state, action, now) -> new state plus the point
 * movements it causes. No I/O, so every rule is unit-tested here; the store then commits the new
 * state and the point movements in one atomic step (and refuses if anything changed meanwhile).
 *
 * Flow: signed-in holders of the coin suggest YES/NO questions (10 points, back when it goes live)
 * and upvote them (free); the streamer or a mod launches them, or their own question (crowd picks
 * are off in the app). Up to MAX_LIVE live predictions at a time, 20 per stream. Viewers bet on a
 * side of each until it locks. Then the AI referee decides first, from stream frames grabbed while it
 * ran. If it can't tell (or the coin has no frames), the streamer or a mod decides YES/NO. An admin
 * (the memestream oracle) may always resolve, YES/NO/Cancel. Winners split that prediction's losing
 * pool (parimutuel, no house fee). Markets then go through the challenge window.
 * A result counts for leaderboards and the asker reward only after its flag window, if not disputed.
 */
import {
  WITNESS_NOTE_MAX,
  AI_CHECK_MAX_TRIES,
  AI_CHECK_MAX_WAIT_MS,
  AI_CHECK_RETRY_MS,
  AI_RUN_LEASE_MS,
  ASKER_REWARD,
  ASKER_REWARD_MIN_BETTORS,
  AUTO_CANCEL_CROWD_MS,
  AUTO_CANCEL_MS,
  AUTO_LAUNCH_UPVOTES,
  byPoints,
  cleanQuestion,
  DEFAULT_WINDOW_MIN,
  DISPUTE_PERCENT,
  FLAG_WINDOW_MS,
  CHECK_RULE_MAX,
  FRAME_GAP_MS,
  FRAME_NOTE_MAX,
  FRAMES_AFTER_LOCK_MS,
  isBetWindow,
  MARKET_FRAMES_AFTER_LOCK_MS,
  MAX_FRAME_NOTES,
  MIN_MARKET_PICTURES,
  REFEREE_GRACE_MS,
  REFEREE_REASON_MAX,
  MAX_BET,
  MAX_BETTORS,
  MAX_HISTORY,
  MAX_MARKET_HISTORY,
  MAX_LIVE,
  MAX_MODS,
  MAX_NOTICES,
  MAX_PREDICTIONS_PER_STREAM,
  MAX_QUEUE,
  MAX_UPVOTERS_STORED,
  MAX_UPVOTES,
  MAX_WON_ENTRIES,
  CHALLENGE_BOND,
  cleanLink,
  cleanReason,
  MARKET_CHALLENGE_MS,
  MARKET_CREATE_MAX_TRIES,
  MARKET_DECISION_MS,
  MARKET_FAILED_RETRY_MS,
  MARKET_RETRY_MS,
  OVERTURN_REWARD,
  MIN_BET,
  MIN_HOLDING_COINS,
  MINUTE_MS,
  NOTICE_MS,
  type Outcome,
  payouts,
  REVIEW_MAX_TRIES,
  REVIEW_RETRY_MS,
  type Side,
  STREAMER_PRESENT_MS,
  SUGGEST_COST,
  SUGGEST_TTL_MS,
} from "./rules";

export type Suggestion = {
  id: string;
  text: string;
  asker: string;
  at: number;
  /** The first upvoters, in full. */
  upvoters: string[];
  /** Later upvoters, as short fingerprints (enough to refuse a second upvote). */
  extra: string[];
  upvotes: number;
  /** Present while the AI review hasn't approved it: only its asker sees it (staff too, once stuck). */
  review?: Review;
  /** The AI review's betting window, if it gave one. */
  windowMin?: number;
};
/** An AI review in progress: checks started so far, and when the last one started. */
export type Review = { tries: number; at: number };
/** A question the streamer or a mod typed, waiting for its review before it goes live (in the AI review's betting window). */
export type PendingLaunch = { id: string; text: string; by: string; at: number; review: Review; source?: string };
/** A short note for one wallet (or every staff wallet, `to: STAFF`) until `until`. */
export type Notice = { to: string; text: string; until: number };
export type BetRecord = { side: Side; amount: number; eligible: boolean };
/**
 * When a stream frame was grabbed: the first at launch, "live" while betting is open, "after" once it
 * closed, "resolve" for a check after someone else resolved it ("lock": older games only).
 */
export type FrameKind = "launch" | "live" | "after" | "lock" | "resolve";
/**
 * A frame grabbed at `at`, as a short description (null: an older game's empty claim). `hash`: a
 * short hash of the picture, so the same picture is described once. `shot`: when the picture was
 * taken, if the CDN said (a preview can be minutes old). Never the image.
 */
export type FrameNote = { kind: FrameKind; at: number; text: string | null; hash?: string; shot?: number };
/** The AI check's second opinion on the streamer's result. */
export type AiVerdict = "agree" | "disagree" | "unclear";
/** An AI check waiting for its verdict: runs started so far, when the last one started, the frames grabbed earlier, the check rule. */
export type AiCheck = { tries: number; at: number; frames: FrameNote[]; rule?: string };
/**
 * Why the referee couldn't tell: no picture from after the lock, only one (a market needs two), the
 * pictures disagreed, jev was unsure, the models kept failing, no answer by the deadline, the daily
 * AI budget ran out, the coin has no AI (no frames, no keys), or the question has an official source
 * (the referee never settles those from the stream).
 */
export type RefereeWhy = "no-picture" | "one-picture" | "disagree" | "unclear" | "error" | "deadline" | "budget" | "no-keys" | "source";
/**
 * The AI referee on a live prediction once betting closed: runs started so far (the latest is the
 * one whose answer counts), when the last one started, and when it gave up (`unclear`, with `why`):
 * from then on the streamer or a mod decides. `waitEnd`: it couldn't tell yet, and runs once more
 * when the frame window ends.
 */
export type Referee = { tries: number; at: number; unclear?: number; why?: RefereeWhy; waitEnd?: true };
/** How the referee decided a result: jev's model, its confidence, what it saw, and the frames' times. */
export type RefereeCall = { model: string; confidence: number; reason: string; frames: number[] };
/**
 * A prediction's on-chain market (MEMESTREAM_MARKETS). Its resolution: opening -> open -> resolved,
 * or failed when it couldn't be created. Its trading, apart: `closed` once the oracle took its
 * liquidity out. The two don't wait on each other: a close that keeps failing never holds up the
 * resolution (the close only gets the seed back). `tries`/`at` claim the next server steps, like an
 * AI check run. `question` is the market's question address once it exists.
 */
export type MarketStep = "opening" | "open" | "resolved" | "failed";
export type MarketState = {
  step: MarketStep;
  closed?: boolean;
  tries: number;
  at: number;
  question?: string;
  challenge?: Challenge;
  decision?: Decision;
};
/** The streamer's (or a mod's) account of what happened: for the admin, or the decision once the AI referee couldn't tell. */
export type Witness = { outcome: Side; note?: string; by: string; at: number };
/** A holder's challenge of the admin's proposed result, with its points bond. */
export type Challenge = { by: string; at: number; reason: string; link?: string; bond: number };
/** How a market pays: one side, or "refund" (every token pays half). */
export type MarketOutcome = Side | "refund";
/** An admin's final word on a market ("auto": nobody decided in time, so it was voided). */
export type Decision = { outcome: MarketOutcome; by: string; at: number };
/** A live prediction: open for bets until `lockAt`, then waiting for a result. */
export type Prediction = {
  id: string;
  text: string;
  /** The viewer who suggested it; null for the streamer's own question. */
  asker: string | null;
  launchedAt: number;
  lockAt: number;
  /** "crowd" (auto-launched by upvotes) or the streamer/mod wallet that launched it. */
  launchedBy: string;
  bets: Record<string, BetRecord>;
  yes: number;
  no: number;
  bettors: number;
  /** Frames grabbed for the AI referee (only on a coin whose stream has frames, with the AI set up). */
  frames?: FrameNote[];
  /** When the last frame grab started (one per FRAME_GAP_MS). */
  grabAt?: number;
  /** What on stream decides YES or NO (a hint for the referee), written once it went live; tries so far and when the last began. */
  rule?: string;
  ruleTries?: number;
  ruleAt?: number;
  /** The AI referee's runs once betting closed. */
  referee?: Referee;
  market?: MarketState;
  /** What the streamer or a mod says happened, once betting closed (in the fallback, their decision). */
  witness?: Witness;
  /** The official source the streamer named for a real-world question (an http(s) link); else the stream decides. */
  source?: string;
};
/**
 * A result, kept short: no per-wallet lists. Only while its flag window is open does it keep
 * `open`, what flagging and counting the result need; then it folds into the summary alone.
 */
export type Summary = {
  id: string;
  text: string;
  asker: string | null;
  outcome: Outcome;
  yes: number;
  no: number;
  bettors: number;
  resolvedAt: number;
  /** "auto" (nobody resolved in time), "ai" (the referee), or the wallet that resolved it (an admin, the streamer or a mod). */
  resolvedBy: string;
  askerReward: number;
  flags: number;
  disputed: boolean;
  open: FlagWindow | null;
  /** The AI check's verdict; absent if no check ran. */
  ai?: { verdict: AiVerdict; at: number };
  /** Present while the AI check runs; the result counts only after it ends. */
  check?: AiCheck;
  market?: MarketState;
  source?: string;
  /** A market's betting window [launchedAt, lockAt], for "stream window HH:MM–HH:MM". */
  window?: [number, number];
  /** What the streamer or a mod said happened. */
  witness?: Witness;
  /** How the AI referee decided it (resolvedBy "ai" only). */
  referee?: RefereeCall;
  /** The streamer or a mod decided because the referee couldn't tell, and why: a market's result then waits for an admin. */
  fallback?: RefereeWhy;
};
export type FlagWindow = {
  /** Each bettor's [stake, payout, flagged (1) or not (0)]. */
  results: Record<string, [number, number, 0 | 1]>;
  /** Bettors with 15+ minutes watched (the asker reward needs enough of them). */
  eligible: number;
};
export type Game = {
  creator: string;
  mods: string[];
  /** "Crowd picks questions": the streamer's switch for auto-launch. */
  crowdPicks: boolean;
  nextId: number;
  /** When the stream that `launched` and `won` belong to started (the streamer's presence `since`). */
  stream: number | null;
  launched: number;
  suggestions: Suggestion[];
  /** Live predictions, oldest first: at most MAX_LIVE. */
  live: Prediction[];
  /** Results, newest first: the last MAX_HISTORY, plus any still in their flag window. */
  resolved: Summary[];
  /** Net points won from bets on this stream, per wallet (top 100 only). */
  won: Record<string, number>;
  /** A staff question under review (at most one; nothing else launches meanwhile). */
  pending: PendingLaunch | null;
  /** "Your question wasn't approved" notes, newest last. */
  notices: Notice[];
};

export type Action =
  | { kind: "tick" }
  | { kind: "suggest"; text: string }
  | { kind: "upvote"; id: string }
  | { kind: "bet"; id: string; side: Side; amount: number }
  | { kind: "launch"; id?: string; text?: string; source?: string }
  | { kind: "remove"; id: string }
  | { kind: "approve"; id: string }
  | { kind: "resolve"; id: string; outcome: Outcome }
  | { kind: "witness"; id: string; outcome: Side; note?: string }
  | { kind: "flag"; id: string }
  | { kind: "mod"; wallet: string; add: boolean }
  | { kind: "crowd"; on: boolean }
  | { kind: "challenge"; id: string; reason: string; link?: string }
  | { kind: "decide"; id: string; outcome: MarketOutcome };

/**
 * Who acts and what the server knows about them: eligibility (they got the sign-in grant, which
 * is capped per IP), whether they hold the coin (the sybil-resistant signal for suggesting and
 * upvoting), and their current balance.
 */
export type Actor = {
  wallet: string;
  eligible: boolean;
  holder: boolean;
  balance: number;
  /** Holds YES or NO shares of the market a challenge, a decision or a resolve is about (one budgeted read, those actions only). */
  shares?: boolean;
  /** The wallet a streamer makes a mod holds shares of one of the coin's open markets (read on chain, mod promotions only). */
  modShares?: boolean;
};
/**
 * Facts from outside the coin's document: when the streamer's own heartbeat last came in, and
 * when their current stream started (their first heartbeat after 2+ hours away).
 */
export type Env = {
  streamerSeenAt: number | null;
  streamStartedAt?: number | null;
  /** The coin's stream has frames and the AI is set up (keys present): the referee decides first. */
  aiCheck?: boolean;
  /** On-chain markets are on (MEMESTREAM_MARKETS): each prediction that goes live gets one. */
  markets?: boolean;
  /** Wallets that settle challenges (MEMESTREAM_ADMIN_WALLETS). */
  admins?: string[];
  /** The challenge window (shorter only in test runs; production always MARKET_CHALLENGE_MS). */
  challengeMs?: number;
  /**
   * Upvoted suggestions go live by themselves. Off in the app (removed 2026-10-12): only the
   * streamer or a mod launches. Kept for the engine's tests.
   */
  crowdPicks?: boolean;
};

/** A balance change: `delta` points, allowed only if the balance is at least `floor` before it. */
export type Movement = { delta: number; floor: number };
export type Result = { game: Game; moves: Map<string, Movement>; won: Map<string, number>; changed: boolean };

/** A rule said no; the message is safe to show the user. */
export class GameError extends Error {}

/** Characters of a wallet kept as an upvote fingerprint. */
const FINGERPRINT_CHARS = 10;
/** A bet may use at most half the balance: the balance must be at least this many times the bet. */
const BALANCE_PER_BET_POINT = 2;
/** `launchedBy` for a prediction the crowd's upvotes launched. */
export const CROWD = "crowd";
/** `resolvedBy` for a prediction nobody resolved in time. */
export const AUTO = "auto";
/** `resolvedBy` for a prediction the AI referee decided. */
export const AI = "ai";
/** `Notice.to` for a note every staff wallet sees. */
export const STAFF = "staff";

export const newGame = (creator: string): Game => ({
  creator,
  mods: [],
  crowdPicks: true,
  nextId: 1,
  stream: null,
  launched: 0,
  suggestions: [],
  live: [],
  resolved: [],
  won: {},
  pending: null,
  notices: [],
});

export const isStaff = (game: Game, wallet: string) => wallet === game.creator || game.mods.includes(wallet);
export const streamerPresent = (env: Env, now: number) => env.streamerSeenAt !== null && now - env.streamerSeenAt < STREAMER_PRESENT_MS;
/** When a locked prediction nobody resolves cancels by itself (crowd picks sooner). */
export const autoCancelAt = (live: Prediction) => live.lockAt + (live.launchedBy === CROWD ? AUTO_CANCEL_CROWD_MS : AUTO_CANCEL_MS);
/** Every check failed: the streamer or a mod approves or removes it by hand. */
export const reviewStuck = (review: Review) => review.tries >= REVIEW_MAX_TRIES;
const reviewDue = (review: Review, now: number) => !reviewStuck(review) && (review.tries === 0 || now >= review.at + REVIEW_RETRY_MS);
/** Whether any question is due a review check now. */
export const reviewsDue = (game: Game, now: number) =>
  [...game.suggestions, ...(game.pending ? [game.pending] : [])].some((item) => item.review && reviewDue(item.review, now));
/** The question a verdict is about: a suggestion or the staff launch, by id. */
export type ReviewTarget = { id: string; text: string };
/** `windowMin`: the AI's betting window, if it gave one (one not in BET_WINDOWS_MIN is ignored). */
export type ReviewVerdict = { approved: true; windowMin?: number | null } | { approved: false; text: string };

export const hasUpvoted = (suggestion: Suggestion, wallet: string) =>
  suggestion.upvoters.includes(wallet) || suggestion.extra.includes(upvoteFingerprint(wallet));
/** Per-stream winnings as leaderboard rows, best first. */
export const rankWon = (won: Game["won"]) =>
  Object.entries(won)
    .map(([wallet, points]) => ({ wallet, points }))
    .sort(byPoints);
const upvoteFingerprint = (wallet: string) => wallet.slice(0, FINGERPRINT_CHARS);

/** Applies `action` by `actor` at `now`. Every action first runs the clock (expiry, auto-cancel, auto-launch). */
export function apply(state: Game, action: Action, actor: Actor | null, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, (ctx) => {
    if (action.kind === "tick") return;
    if (!actor) throw new GameError("Sign in to play");
    act(ctx, action, actor);
  });
}

/**
 * Starts a review of every question that is due one (never checked, or its last check started
 * 15+ s ago and tries are left): counts the try and returns what to check. Committing this first
 * claims the check, so two servers never check the same question at the same moment.
 */
export function startReviews(state: Game, now: number, env: Env = { streamerSeenAt: null }): Result & { due: ReviewTarget[] } {
  const due: ReviewTarget[] = [];
  const result = run(state, now, env, ({ game }) => {
    const items = [...game.suggestions, ...(game.pending ? [game.pending] : [])];
    for (const item of items) {
      if (!item.review || !reviewDue(item.review, now)) continue;
      item.review = { tries: item.review.tries + 1, at: now };
      due.push({ id: item.id, text: item.text });
    }
  });
  return { ...result, due };
}

/**
 * A review's verdict. Approved: a suggestion joins the queue, a staff question goes live (its bet
 * window starts now). Not approved: a suggestion leaves (its 10 points stay spent), a
 * staff question is dropped (no launch used); either way the asker sees the note. A question no
 * longer under review (decided by hand, expired, changed) is left alone.
 */
export function applyReview(state: Game, target: ReviewTarget, verdict: ReviewVerdict, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, (ctx) => {
    if (verdict.approved) approveReview(ctx, target, isBetWindow(verdict.windowMin) ? verdict.windowMin : undefined);
    else rejectReview(ctx, target, verdict.text, false);
  });
}

/** What the asker sees when the daily AI budget stops reviews. */
export const REVIEW_PAUSED_TEXT = "The AI review is paused for today. The streamer can approve your question by hand.";

/**
 * The daily AI budget stopped a question's review: no more checks are tried (it is stuck, so the
 * streamer or a mod approves or removes it by hand), and its asker (or the staff) is told why. A
 * question no longer under review is left alone.
 */
export function applyReviewPaused(state: Game, target: ReviewTarget, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, (ctx) => {
    const { game } = ctx;
    const s = game.suggestions.find((x) => x.id === target.id && x.text === target.text && x.review);
    const item = s ?? (game.pending?.id === target.id && game.pending.text === target.text ? game.pending : null);
    if (!item?.review) return;
    item.review = { ...item.review, tries: REVIEW_MAX_TRIES };
    notify(ctx, s ? s.asker : STAFF, REVIEW_PAUSED_TEXT);
  });
}

/** A frame to grab for a live prediction: claimed at `at`; `hashes` are the pictures it already has. */
export type CaptureTarget = { id: string; text: string; rule: string | null; kind: FrameKind; at: number; hashes: string[] };
/** A result to check: its question, the outcome someone else gave, the frames grabbed before, and which run this is. */
export type CheckTarget = { id: string; text: string; rule: string | null; outcome: Side; frames: FrameNote[]; tries: number };
/**
 * A locked prediction for the referee to decide, from its frames; `tries` is this run's number (its
 * answer counts only while it is the latest run). `market`: a real-SOL market rides on it, so the
 * referee needs MIN_MARKET_PICTURES pictures from after the lock that agree.
 */
export type RefereeTarget = { id: string; text: string; rule: string | null; lockAt: number; frames: FrameNote[]; tries: number; market: boolean };
/** A live prediction that needs its check rule written. */
export type RuleTarget = { id: string; text: string };
/** The referee's answer: a side with how it decided, or why it couldn't tell (then the streamer decides). */
export type RefereeAnswer = ({ outcome: Side } & RefereeCall) | { unclear: RefereeWhy };

/**
 * Links and anything that reads as a domain are cut from model text that is shown to people (a
 * reason, a rule): any word.word with 2+ letters after the dot, spaced "x . com", and "x dot com".
 */
const LINKS = /\S*(?:https?:\/\/|www\.)\S*|\S+\.[a-z]{2,}\S*|\S+\s+\.\s+[a-z]{2,}\b\S*|\S+\s+dot\s+(?:com|net|org|io|gg|tv|xyz|lol|me|app|co)\b\S*/gi;
const withoutLinks = (text: string) => text.replace(LINKS, "").replace(/\s+/g, " ").trim();
/** A written rule: plain text on one line, no links, cut to CHECK_RULE_MAX; none if empty. */
const cleanRule = (rule: string | null | undefined) => (rule ? withoutLinks(rule).slice(0, CHECK_RULE_MAX) : "") || undefined;
/**
 * A claimed AI run holds its lease (AI_RUN_LEASE_MS, longer than a whole run with its timeouts and
 * retries) unless it gave it back after a failure (releaseAiRun); only then may another run start.
 */
const leaseOver = (claim: { at: number }, now: number) => now >= claim.at + AI_RUN_LEASE_MS;
const checkDue = (check: AiCheck, now: number) => check.tries < AI_CHECK_MAX_TRIES && (check.tries === 0 || leaseOver(check, now));
/** A prediction with a real-SOL market (one that opened or is opening). */
const hasMarket = (p: { market?: MarketState }) => p.market !== undefined && p.market.step !== "failed";
/** Grabbing goes on this long after the lock: longer for a market, to catch a second preview refresh. */
export const frameWindowEnd = (live: Prediction) => live.lockAt + (hasMarket(live) ? MARKET_FRAMES_AFTER_LOCK_MS : FRAMES_AFTER_LOCK_MS);
/** With no YES or NO by then, the referee couldn't tell. */
export const refereeDeadline = (live: Prediction) => frameWindowEnd(live) + REFEREE_GRACE_MS;
/** When a note's picture was taken: the CDN's Last-Modified when it gave one, else when it was grabbed. */
export const shotAt = (f: FrameNote) => f.shot ?? f.at;
/**
 * Described pictures taken at or after the lock (a preview can be minutes old when grabbed). For a
 * market (`strict`), only pictures whose CDN time says so: a grab time alone proves nothing.
 */
export const freshNotes = (live: { lockAt: number; frames?: FrameNote[] }, strict = false) =>
  (live.frames ?? []).filter((f) => f.text && (strict ? f.shot !== undefined && f.shot >= live.lockAt : shotAt(f) >= live.lockAt));
const ended = (r: Referee | undefined) => r?.unclear !== undefined;
/** A grab is due while it runs and until the frame window ends, at most every FRAME_GAP_MS, unless the referee gave up. */
const grabDue = (live: Prediction, now: number) => !ended(live.referee) && now < frameWindowEnd(live) && (live.grabAt === undefined || now >= live.grabAt + FRAME_GAP_MS);
/** The rule is written once the prediction is live: at most two tries, a pause apart. */
const ruleDue = (live: Prediction, now: number) => !live.rule && (live.ruleTries ?? 0) < 2 && (live.ruleAt === undefined || leaseOver({ at: live.ruleAt }, now));
/**
 * The referee's first run waits for enough fresh pictures (one; MIN_MARKET_PICTURES for a market), or
 * the end of the frame window. An early "couldn't tell" waits for one last run at the window's end. A
 * failed run is tried again after a pause.
 */
function refereeDue(live: Prediction, now: number): boolean {
  if (now < live.lockAt) return false;
  const r = live.referee;
  const enough = freshNotes(live, hasMarket(live)).length >= (hasMarket(live) ? MIN_MARKET_PICTURES : 1);
  if (!r) return enough || now >= frameWindowEnd(live);
  if (ended(r)) return false;
  if (r.waitEnd) return now >= frameWindowEnd(live);
  return r.tries < AI_CHECK_MAX_TRIES && leaseOver(r, now);
}

/**
 * Where a live prediction's result stands: null while betting is open; "checking" while the AI
 * referee works on it; "unclear" once it couldn't tell, or when the coin has no AI (no frames, no
 * keys): then the streamer or a mod decides (for a market, only as a proposal an admin settles).
 */
export function refereeState(live: Prediction, now: number, env: Env): "checking" | "unclear" | null {
  if (now < live.lockAt) return null;
  return !refereeOn(live, env) || ended(live.referee) ? "unclear" : "checking";
}

/** Why the referee couldn't tell, once it couldn't (or the coin has no AI); null otherwise. */
export function refereeWhy(live: Prediction, env: Env): RefereeWhy | null {
  if (live.source) return "source";
  if (ended(live.referee)) return live.referee!.why ?? "unclear";
  return env.aiCheck ? null : "no-keys";
}

/**
 * The referee works on a prediction only when the coin has the AI and the question has no official
 * source: a result that comes from an outside source ("Resolves from <link>") is never settled from
 * the stream. The streamer or a mod decides it (on a market, only as a proposal an admin settles).
 */
const refereeOn = (live: Prediction, env: Env) => Boolean(env.aiCheck) && !live.source;

/** Whether a frame grab, a rule, a referee run or an AI check is due now. */
export const aiDue = (game: Game, now: number, env: Env) =>
  game.live.some((live) => refereeOn(live, env) && (ruleDue(live, now) || grabDue(live, now) || refereeDue(live, now))) ||
  game.resolved.some((p) => p.check && checkDue(p.check, now));

/** A grab joins one that is due for another prediction of the coin unless it grabbed this recently: one picture serves them all. */
const GRAB_JOIN_MS = 10_000;

/**
 * Claims every due rule, frame grab, referee run and AI check run, like startReviews: committing this
 * first means no other server starts the same one. When one prediction's grab is due, every other
 * one still in its frame window joins it, so their grabs line up and a picture is described once.
 */
export function startAi(state: Game, now: number, env: Env): Result & { rules: RuleTarget[]; captures: CaptureTarget[]; referees: RefereeTarget[]; checks: CheckTarget[] } {
  const rules: RuleTarget[] = [];
  const captures: CaptureTarget[] = [];
  const referees: RefereeTarget[] = [];
  const checks: CheckTarget[] = [];
  const result = run(state, now, env, ({ game }) => {
    const grabbing = game.live.some((live) => refereeOn(live, env) && grabDue(live, now) && !refereeDue(live, now));
    const joins = (live: Prediction) => grabbing && !ended(live.referee) && now < frameWindowEnd(live) && (live.grabAt === undefined || now >= live.grabAt + GRAB_JOIN_MS);
    for (const live of game.live.filter((p) => refereeOn(p, env))) {
      if (ruleDue(live, now)) {
        Object.assign(live, { ruleTries: (live.ruleTries ?? 0) + 1, ruleAt: now });
        rules.push({ id: live.id, text: live.text });
      }
      const rule = live.rule ?? null;
      if (refereeDue(live, now)) {
        live.referee = { tries: (live.referee?.tries ?? 0) + 1, at: now };
        referees.push({ id: live.id, text: live.text, rule, lockAt: live.lockAt, frames: live.frames ?? [], tries: live.referee.tries, market: hasMarket(live) });
      } else if (grabDue(live, now) || joins(live)) {
        live.grabAt = now;
        const kind = now >= live.lockAt ? "after" : live.frames?.length ? "live" : "launch";
        captures.push({ id: live.id, text: live.text, rule, kind, at: now, hashes: (live.frames ?? []).flatMap((f) => (f.hash ? [f.hash] : [])) });
      }
    }
    for (const p of game.resolved) {
      if (!p.check || !checkDue(p.check, now) || p.outcome === "cancel") continue;
      p.check = { ...p.check, tries: p.check.tries + 1, at: now };
      checks.push({ id: p.id, text: p.text, rule: p.check.rule ?? null, outcome: p.outcome, frames: p.check.frames, tries: p.check.tries });
    }
  });
  return { ...result, rules, captures, referees, checks };
}

/** The written check rule (null: writing it failed). Only fills a live prediction that has none. */
export function applyRule(state: Game, id: string, rule: string | null, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, ({ game }) => {
    const live = findLive(game, id);
    const clean = cleanRule(rule);
    if (live && !live.rule && clean) live.rule = clean;
  });
}

/** Adds a described picture to `notes`, in time order; past MAX_FRAME_NOTES the first and the newest stay. */
function withNote(notes: FrameNote[], note: FrameNote): FrameNote[] {
  const all = [...notes.filter((f) => f.text), note].sort((a, b) => a.at - b.at);
  return all.length <= MAX_FRAME_NOTES ? all : [all[0], ...all.slice(-(MAX_FRAME_NOTES - 1))];
}

/**
 * A grabbed frame's description (null: no frame). `shot`: when the picture was taken, if the CDN
 * said (never later than the grab). A picture already described (same hash) is not added again. It
 * goes to the live prediction, or to the check of a result resolved meanwhile.
 */
export const applyFrame = (state: Game, target: CaptureTarget, frame: Evidence | null, now: number, env: Env = { streamerSeenAt: null }): Result => applyFrames(state, [target], frame, now, env);

/** A grabbed frame's description, as applyFrame, for every prediction it was grabbed for: one transition, so the clock's movements are all kept. */
export function applyFrames(state: Game, targets: CaptureTarget[], frame: Evidence | null, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, ({ game }) => {
    if (!frame || !frame.text) return;
    for (const target of targets) {
      const shot = frame.shot !== undefined && Number.isFinite(frame.shot) ? Math.min(frame.shot, target.at) : undefined;
      const note: FrameNote = { kind: target.kind, at: target.at, text: frame.text.slice(0, FRAME_NOTE_MAX), hash: frame.hash, ...(shot !== undefined ? { shot } : {}) };
      const live = findLive(game, target.id);
      const check = live ? null : game.resolved.find((p) => p.id === target.id)?.check;
      const notes = live ? (live.frames ?? []) : check?.frames;
      if (!notes || notes.some((f) => f.hash === frame.hash)) continue;
      if (live) live.frames = withNote(notes, note);
      else if (check) check.frames = withNote(notes, note);
    }
  });
}
/** A described piece of evidence: its text, a hash of the media, and when it was taken, if known. */
type Evidence = { hash: string; text: string; shot?: number };

/**
 * The referee's answer from run `tries` on a locked prediction; an answer from an older run, or one
 * that ended, is ignored. YES or NO resolves it ("ai"), as an admin's resolve would: points are paid,
 * a market goes into its challenge window. "Couldn't tell" before the frame window ends waits for one
 * last run at its end (unless the models failed or the budget is spent); after it, the streamer or a
 * mod decides, and why is kept for the admins.
 */
export function applyReferee(state: Game, id: string, tries: number, answer: RefereeAnswer, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, (ctx) => {
    const live = findLive(ctx.game, id);
    const r = live?.referee;
    if (!live || !r || ended(r) || r.tries !== tries || now < live.lockAt) return;
    if ("unclear" in answer) {
      // Failing models or a spent budget won't get better by waiting: those end it at once.
      const final = now >= frameWindowEnd(live) || answer.unclear === "error" || answer.unclear === "budget";
      live.referee = final ? { ...r, unclear: now, why: answer.unclear } : { ...r, waitEnd: true, why: answer.unclear };
      return;
    }
    const { outcome, model, confidence, reason, frames } = answer;
    settle(ctx, live, outcome, AI, { model: model.slice(0, 80), confidence, reason: withoutLinks(reason).slice(0, REFEREE_REASON_MAX), frames: frames.slice(0, MAX_FRAME_NOTES) });
  });
}

/**
 * A referee run or check run (`id`, run `tries`) that failed gives its lease back: the next run may
 * start AI_CHECK_RETRY_MS from now. Only the current run can; anything else is left alone.
 */
export function releaseAiRun(state: Game, id: string, tries: number, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, ({ game }) => {
    const released = now - AI_RUN_LEASE_MS + AI_CHECK_RETRY_MS;
    const r = findLive(game, id)?.referee;
    if (r && !ended(r) && !r.waitEnd && r.tries === tries && r.at > released) r.at = released;
    const check = game.resolved.find((p) => p.id === id)?.check;
    if (check && check.tries === tries && check.at > released) check.at = released;
  });
}

/**
 * The AI check's verdict on a result someone else resolved (null: no evidence, so no check), from
 * run `tries` (an older run's verdict is ignored). A disagree marks it disputed, as bettors' flags
 * do; since the result counts only after its check ends, a late verdict still keeps it off the
 * leaderboards and the asker reward. A result already checked is left alone.
 */
export function applyAiVerdict(state: Game, id: string, verdict: AiVerdict | null, now: number, env: Env = { streamerSeenAt: null }, tries?: number): Result {
  return run(state, now, env, ({ game }) => {
    const p = game.resolved.find((x) => x.id === id && x.check);
    if (!p || (tries !== undefined && p.check!.tries !== tries)) return;
    delete p.check;
    if (!verdict) return;
    p.ai = { verdict, at: now };
    if (verdict === "disagree") p.disputed = true;
  });
}

/** A server step on a prediction's market: create it, close its trading, or resolve it. */
export type MarketJob = { id: string; kind: "create" } | { id: string; kind: "close" } | { id: string; kind: "resolve"; outcome: MarketOutcome };

const marketRetryDue = (m: MarketState, now: number) => m.tries === 0 || now >= m.at + MARKET_RETRY_MS;
/** The market still needs a server step: to open, to resolve, or to close (its seed comes back then). */
const marketPending = (m: MarketState | undefined) => m !== undefined && m.step !== "failed" && (m.step !== "resolved" || !m.closed);

/** When a proposed result goes final if nobody challenges it. */
export const challengeEndsAt = (p: Summary, env: Env) => p.resolvedAt + (env.challengeMs ?? MARKET_CHALLENGE_MS);

/** The proposal for a market: the YES/NO given, or a cancel, which proposes a refund. */
export const proposedOutcome = (p: Summary): MarketOutcome => (p.outcome === "cancel" ? "refund" : p.outcome);

/**
 * Why a market waits for an admin without anyone challenging it, and since when: nobody resolved it
 * (auto-cancelled), the streamer or a mod decided because the AI referee couldn't tell (their call is
 * only a proposal on real SOL), or the AI check disagreed with the result. Never settled
 * automatically, so the streamer can't force a result or a refund; MARKET_DECISION_MS later it is
 * voided as a last resort.
 */
export function needsAdmin(p: Summary): { why: "unresolved" | "fallback" | "ai"; since: number } | null {
  if (!p.market || p.market.step === "opening" || p.market.step === "failed") return null;
  if (p.resolvedBy === AUTO) return { why: "unresolved", since: p.resolvedAt };
  if (p.fallback) return { why: "fallback", since: p.resolvedAt };
  if (p.ai?.verdict === "disagree") return { why: "ai", since: p.ai.at };
  return null;
}

/**
 * What a market pays, once that's settled; null while it isn't yet.
 * - An admin decided: their outcome.
 * - Challenged, or needing an admin (needsAdmin): waits for one.
 * - Otherwise the streamer's proposal (YES, NO, or a cancel's refund), once the challenge window is
 *   over and the AI check is done. Points flags never count: they cost nothing, so a crowd of free
 *   wallets could otherwise force a real-SOL refund (they still keep a result off the points leaderboard).
 */
export function marketFinal(p: Summary, now: number, env: Env): MarketOutcome | null {
  const m = p.market;
  if (!m) return null;
  if (m.decision) return m.decision.outcome;
  if (m.challenge || needsAdmin(p)) return null;
  if (now < challengeEndsAt(p, env) || p.check) return null;
  return proposedOutcome(p);
}

/**
 * The steps due on one prediction's market: create while it's live and taking bets; close trading
 * once betting closes (until it's done); resolve once its outcome is final AND trading is closed. A
 * confirmed close is a prerequisite: resolving while the oracle's liquidity is still in the pool
 * would let losers swap into winners at a stale price. So the two are never due together.
 */
function marketJobsFor(p: Prediction | Summary, live: boolean, now: number, env: Env): MarketJob[] {
  const m = p.market;
  if (!m || !marketRetryDue(m, now)) return [];
  if (m.step === "opening") return live && now < (p as Prediction).lockAt && m.tries < MARKET_CREATE_MAX_TRIES ? [{ id: p.id, kind: "create" }] : [];
  if (m.step === "failed") return [];
  const jobs: MarketJob[] = [];
  if (!m.closed && (!live || now >= (p as Prediction).lockAt)) jobs.push({ id: p.id, kind: "close" });
  const outcome = m.step === "open" && !live && m.closed ? marketFinal(p as Summary, now, env) : null;
  if (outcome) jobs.push({ id: p.id, kind: "resolve", outcome });
  return jobs;
}

function marketJobs(game: Game, now: number, env: Env): { p: Prediction | Summary; job: MarketJob }[] {
  const out: { p: Prediction | Summary; job: MarketJob }[] = [];
  for (const [list, live] of [[game.live, true], [game.resolved, false]] as const) {
    for (const p of list) for (const job of marketJobsFor(p, live, now, env)) out.push({ p, job });
  }
  return out;
}

/** Whether any of the game's markets still needs a server step (opening, resolving or closing). */
export const hasPendingMarkets = (game: Game) => [...game.live, ...game.resolved].some((p) => marketPending(p.market));

/** Whether any market step is due now. */
export const marketsDue = (game: Game, now: number, env: Env) => marketJobs(game, now, env).length > 0;

/** Claims every due market step (counts the try), like startAi: committing this first means no other server starts the same one. */
export function startMarkets(state: Game, now: number, env: Env = { streamerSeenAt: null }): Result & { jobs: MarketJob[] } {
  const jobs: MarketJob[] = [];
  const result = run(state, now, env, ({ game }) => {
    const claimed = new Set<string>();
    for (const { p, job } of marketJobs(game, now, env)) {
      if (!claimed.has(p.id)) p.market = { ...p.market!, tries: p.market!.tries + 1, at: now };
      claimed.add(p.id);
      jobs.push(job);
    }
  });
  return { ...result, jobs };
}

/**
 * A market step that succeeded on-chain. Only changes a market still waiting for that step; a repeat
 * is left alone. Everything else on the market (its challenge, decision, close) is kept. A create that
 * lands after the market was given up on still opens it, so its seed is closed out and redeemed.
 */
export function applyMarketDone(state: Game, job: MarketJob, question: string | null, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, ({ game }) => {
    const p = [...game.live, ...game.resolved].find((x) => x.id === job.id);
    const m = p?.market;
    if (!p || !m) return;
    if (job.kind === "create" && (m.step === "opening" || m.step === "failed")) {
      const address = question ?? m.question;
      p.market = { ...m, step: "open", tries: 0, at: now, ...(address ? { question: address } : {}) };
    }
    if (job.kind === "close" && !m.closed && m.step !== "opening" && m.step !== "failed") p.market = { ...m, closed: true, tries: 0, at: now };
    if (job.kind === "resolve" && m.step === "open") p.market = { ...m, step: "resolved", tries: 0, at: now };
  });
}

/** A run whose step failed gives its claim back early: the market's due steps are tried again after MARKET_FAILED_RETRY_MS. */
export function applyMarketTryFailed(state: Game, id: string, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, ({ game }) => {
    const p = [...game.live, ...game.resolved].find((x) => x.id === id);
    const m = p?.market;
    const released = now - MARKET_RETRY_MS + MARKET_FAILED_RETRY_MS;
    if (p && m && m.tries > 0 && m.at > released) p.market = { ...m, at: released };
  });
}

/** A market that can never open (someone else made a pool at its address): give up now, no retries. */
export function applyMarketUnavailable(state: Game, id: string, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, ({ game }) => {
    const p = [...game.live, ...game.resolved].find((x) => x.id === id);
    if (p?.market?.step === "opening") p.market = { ...p.market, step: "failed" };
  });
}

/** Runs the clock, then `step`, then the clock again (a step may free the slot for the next suggestion). */
function run(state: Game, now: number, env: Env, step: (ctx: Ctx) => void): Result {
  const game: Game = structuredClone(state);
  const moves = new Map<string, Movement>();
  const won = new Map<string, number>();
  const credit = (wallet: string, points: number) => {
    if (points === 0) return;
    const m = moves.get(wallet) ?? { delta: 0, floor: 0 };
    moves.set(wallet, { delta: m.delta + points, floor: m.floor });
  };
  const debit = (wallet: string, points: number, floor: number) => {
    const m = moves.get(wallet) ?? { delta: 0, floor: 0 };
    moves.set(wallet, { delta: m.delta - points, floor: Math.max(m.floor, floor) });
  };
  const ctx: Ctx = { game, credit, debit, won, now, env };

  tick(ctx);
  step(ctx);
  tick(ctx);
  return { game, moves, won, changed: JSON.stringify(game) !== JSON.stringify(state) };
}

type Ctx = {
  game: Game;
  now: number;
  env: Env;
  credit: (wallet: string, points: number) => void;
  debit: (wallet: string, points: number, floor: number) => void;
  won: Map<string, number>;
};

function tick(ctx: Ctx) {
  startNewStream(ctx);
  expireSuggestions(ctx);
  expireNotices(ctx);
  autoCancelUnresolved(ctx);
  endStaleReferees(ctx);
  endStaleChecks(ctx);
  endUnopenedMarkets(ctx);
  voidUndecided(ctx);
  closeFlagWindows(ctx);
  launchCrowdPick(ctx);
}

/** A new stream: a fresh 20 and a fresh stream leaderboard; past results stay. */
function startNewStream({ game, env }: Ctx) {
  const started = env.streamStartedAt ?? null;
  if (started !== null && started !== game.stream) Object.assign(game, { stream: started, launched: 0, won: {} });
}

/**
 * Suggestions that didn't go live in 20 minutes expire; their 10 points are spent, unless the
 * review never finished (then they come back). A staff question still under review goes too.
 */
function expireSuggestions({ game, now, credit }: Ctx) {
  for (const s of game.suggestions) if (s.review && now >= s.at + SUGGEST_TTL_MS) credit(s.asker, SUGGEST_COST);
  game.suggestions = game.suggestions.filter((s) => now < s.at + SUGGEST_TTL_MS);
  if (game.pending && now >= game.pending.at + SUGGEST_TTL_MS) game.pending = null;
}

function expireNotices({ game, now }: Ctx) {
  game.notices = game.notices.filter((n) => now < n.until);
}

/** One note per wallet: a new one replaces the old; past MAX_NOTICES the oldest goes. */
function notify({ game, now }: Ctx, to: string, text: string) {
  game.notices = [...game.notices.filter((n) => n.to !== to), { to, text, until: now + NOTICE_MS }].slice(-MAX_NOTICES);
}

/** `aiWindowMin`: the AI review's betting window; without one, the question gets DEFAULT_WINDOW_MIN. */
function approveReview(ctx: Ctx, target: ReviewTarget, aiWindowMin?: number) {
  const { game } = ctx;
  const s = game.suggestions.find((x) => x.id === target.id && x.text === target.text && x.review);
  if (s) {
    delete s.review;
    if (aiWindowMin !== undefined) s.windowMin = aiWindowMin;
    return;
  }
  const p = game.pending;
  if (!p || p.id !== target.id || p.text !== target.text) return;
  game.pending = null;
  if (game.live.length >= MAX_LIVE || game.launched >= MAX_PREDICTIONS_PER_STREAM) return notify(ctx, STAFF, "Not launched: no slot was free");
  launch(ctx, { id: p.id, text: p.text, source: p.source }, p.by, aiWindowMin ?? DEFAULT_WINDOW_MIN);
}

/** `refund`: only when no review could decide (stuck, removed by hand); a question jev rejected keeps its cost, so rejected spam is never free. */
function rejectReview(ctx: Ctx, target: ReviewTarget, text: string, refund: boolean) {
  const { game } = ctx;
  const s = game.suggestions.find((x) => x.id === target.id && x.text === target.text && x.review);
  if (s) {
    game.suggestions = game.suggestions.filter((x) => x !== s);
    if (refund) ctx.credit(s.asker, SUGGEST_COST);
    return notify(ctx, s.asker, text);
  }
  const p = game.pending;
  if (!p || p.id !== target.id || p.text !== target.text) return;
  game.pending = null;
  notify(ctx, STAFF, text);
}

/** A locked prediction nobody resolved cancels by itself: full refunds. */
function autoCancelUnresolved(ctx: Ctx) {
  for (const p of ctx.game.live.filter((x) => ctx.now >= autoCancelAt(x))) settle(ctx, p, "cancel", AUTO);
}

/**
 * A referee that ran out of tries, or has no YES or NO by its deadline (the frame window plus
 * REFEREE_GRACE_MS, whatever the server's keys), couldn't tell: the streamer or a mod decides.
 */
function endStaleReferees({ game, now }: Ctx) {
  for (const live of game.live) {
    const r = live.referee;
    if (now < live.lockAt || r?.unclear !== undefined) continue;
    // The last run is never written off while it still holds its lease.
    const triedOut = r !== undefined && !r.waitEnd && r.tries >= AI_CHECK_MAX_TRIES && leaseOver(r, now);
    if (triedOut) live.referee = { ...r, unclear: now, why: "error" };
    else if (now >= refereeDeadline(live)) live.referee = { tries: r?.tries ?? 0, at: r?.at ?? now, unclear: now, why: r?.why ?? "deadline" };
  }
}

/** An AI check whose every run failed, or that passed its hard deadline, ends as "couldn't tell". */
function endStaleChecks({ game, now }: Ctx) {
  for (const p of game.resolved) {
    if (!p.check) continue;
    const triedOut = p.check.tries >= AI_CHECK_MAX_TRIES && leaseOver(p.check, now);
    // Also ends when no run will ever come (keys removed, AI off): a result can never wait forever.
    const pastDeadline = now >= p.resolvedAt + FLAG_WINDOW_MS + AI_CHECK_MAX_WAIT_MS;
    if (!triedOut && !pastDeadline) continue;
    delete p.check;
    p.ai = { verdict: "unclear", at: now };
  }
}

/**
 * A market that never opened is given up on: every create try failed, or betting closed first.
 * Its prediction stays a points game.
 */
function endUnopenedMarkets({ game, now }: Ctx) {
  for (const [list, live] of [[game.live, true], [game.resolved, false]] as const) {
    for (const p of list) {
      const m = p.market;
      // Not while a create try may still be running.
      if (m?.step !== "opening" || !marketRetryDue(m, now)) continue;
      if (m.tries >= MARKET_CREATE_MAX_TRIES || !live || now >= (p as Prediction).lockAt) p.market = { ...m, step: "failed" };
    }
  }
}

/**
 * Last resort: a market waiting for an admin (challenged, unresolved, or the AI disagreed) that no
 * admin decided within MARKET_DECISION_MS is voided: a refund, and a challenger's bond comes back.
 */
function voidUndecided(ctx: Ctx) {
  for (const p of ctx.game.resolved) {
    const m = p.market;
    if (!m || m.decision || m.step !== "open") continue;
    const since = m.challenge?.at ?? needsAdmin(p)?.since;
    if (since === undefined || ctx.now < since + MARKET_DECISION_MS) continue;
    m.decision = { outcome: "refund", by: AUTO, at: ctx.now };
    if (m.challenge) ctx.credit(m.challenge.by, m.challenge.bond);
  }
}

/** Results past their flag window, with no AI check still running, count now (unless disputed); then only the last MAX_HISTORY stay. */
function closeFlagWindows(ctx: Ctx) {
  const { game, now } = ctx;
  for (const p of game.resolved) if (p.open && !p.check && now >= p.resolvedAt + FLAG_WINDOW_MS) finalize(ctx, p);
  // A result whose market still needs closing or resolving stays until it's done; the newest
  // MAX_MARKET_HISTORY settled markets stay too, so holders can still find them to redeem.
  let markets = 0;
  game.resolved = game.resolved.filter((p, i) => {
    const settled = p.market?.step === "resolved";
    if (settled) markets += 1;
    return p.open || i < MAX_HISTORY || marketPending(p.market) || (settled && markets <= MAX_MARKET_HISTORY);
  });
}

/** The crowd picks, into every free live slot: only while the streamer is here and has crowd picks on. */
function launchCrowdPick(ctx: Ctx) {
  const { game, now } = ctx;
  if (!ctx.env.crowdPicks || game.pending || !game.crowdPicks || !streamerPresent(ctx.env, now)) return;
  while (game.live.length < MAX_LIVE && game.launched < MAX_PREDICTIONS_PER_STREAM) {
    const top = [...game.suggestions]
      .filter((s) => !s.review && s.upvotes >= AUTO_LAUNCH_UPVOTES)
      .sort((a, b) => b.upvotes - a.upvotes || a.at - b.at || Number(a.id) - Number(b.id))[0];
    if (!top) return;
    launch(ctx, top, CROWD, top.windowMin ?? DEFAULT_WINDOW_MIN);
  }
}

function launch(ctx: Ctx, from: Suggestion | { id?: string; text: string; source?: string }, by: string, windowMin: number) {
  const { game, now } = ctx;
  let id: string;
  let asker: string | null = null;
  if ("asker" in from) {
    game.suggestions = game.suggestions.filter((s) => s.id !== from.id);
    ctx.credit(from.asker, SUGGEST_COST); // the suggestion cost comes back when it goes live
    id = from.id;
    asker = from.asker;
  } else {
    id = from.id ?? String(game.nextId++);
  }
  game.launched += 1;
  game.live.push({
    id,
    text: from.text,
    asker,
    launchedAt: now,
    lockAt: now + windowMin * MINUTE_MS,
    launchedBy: by,
    bets: {},
    yes: 0,
    no: 0,
    bettors: 0,
    ...(ctx.env.markets ? { market: { step: "opening" as const, tries: 0, at: now } } : {}),
    ...("source" in from && from.source ? { source: from.source } : {}),
  });
}

/**
 * Pays out live prediction `p` at once; winnings for leaderboards and the asker reward wait for the
 * flag window. `call`: how the referee decided it (by AI only). `fallback`: why the referee couldn't
 * tell, when the streamer or a mod decided.
 */
function settle(ctx: Ctx, p: Prediction, outcome: Outcome, by: string, call?: RefereeCall, fallback?: RefereeWhy) {
  const { game, now } = ctx;
  const bets = Object.entries(p.bets).map(([wallet, b]) => ({ wallet, side: b.side, amount: b.amount }));
  const paid = payouts(bets, outcome);
  const results: FlagWindow["results"] = {};
  for (const b of bets) {
    const payout = paid.get(b.wallet) ?? 0;
    ctx.credit(b.wallet, payout);
    results[b.wallet] = [b.amount, payout, 0];
  }
  const eligible = Object.values(p.bets).filter((b) => b.eligible).length;
  const { id, text, asker, yes, no, bettors } = p;
  game.live = game.live.filter((x) => x !== p);
  const summary: Summary = { id, text, asker, outcome, yes, no, bettors, resolvedAt: now, resolvedBy: by, askerReward: 0, flags: 0, disputed: false, open: { results, eligible } };
  // A YES/NO someone else gave gets an AI check when the coin's stream has frames; a cancel or the referee's own result needs none.
  if (outcome !== "cancel" && refereeOn(p, ctx.env) && by !== AI) summary.check = { tries: 0, at: now, frames: p.frames ?? [], ...(p.rule ? { rule: p.rule } : {}) };
  if (call) summary.referee = call;
  if (fallback) summary.fallback = fallback;
  if (p.market) Object.assign(summary, { market: p.market, window: [p.launchedAt, p.lockAt] });
  if (p.source) summary.source = p.source;
  if (p.witness) summary.witness = p.witness;
  game.resolved.unshift(summary);
}

/** The flag window is over: the winnings count (unless disputed), the asker reward is settled, the lists go. */
function finalize(ctx: Ctx, p: Summary) {
  const open = p.open!;
  p.open = null;
  if (p.disputed || p.outcome === "cancel") return;
  countWinnings(ctx, open);
  if (p.asker && open.eligible >= ASKER_REWARD_MIN_BETTORS) {
    p.askerReward = ASKER_REWARD;
    ctx.credit(p.asker, ASKER_REWARD);
  }
}

/** Adds each bettor's net result to the stream leaderboard (top MAX_WON_ENTRIES kept) and the all-time one. */
function countWinnings(ctx: Ctx, open: FlagWindow) {
  const { game } = ctx;
  for (const [wallet, [stake, payout]] of Object.entries(open.results)) {
    const net = payout - stake;
    if (net === 0) continue;
    game.won[wallet] = (game.won[wallet] ?? 0) + net;
    ctx.won.set(wallet, (ctx.won.get(wallet) ?? 0) + net);
  }
  const top = rankWon(game.won).slice(0, MAX_WON_ENTRIES);
  game.won = Object.fromEntries(top.map((l) => [l.wallet, l.points]));
}

type PlayerAction = Exclude<Action, { kind: "tick" }>;
type ActionOf<K extends PlayerAction["kind"]> = Extract<PlayerAction, { kind: K }>;

function act(ctx: Ctx, action: PlayerAction, actor: Actor) {
  switch (action.kind) {
    case "suggest":
      return suggest(ctx, actor, action.text);
    case "upvote":
      return upvote(ctx, actor, action.id);
    case "bet":
      return bet(ctx, actor, action);
    case "launch":
      return launchByStaff(ctx, actor, action);
    case "remove":
      return removeSuggestion(ctx, actor, action.id);
    case "approve":
      return approveByHand(ctx, actor, action.id);
    case "resolve":
      return resolve(ctx, actor, action);
    case "witness":
      return witness(ctx, actor, action);
    case "flag":
      return flagResult(ctx, actor, action.id);
    case "mod":
      return changeMods(ctx, actor, action);
    case "crowd":
      requireStaff(ctx.game, actor);
      ctx.game.crowdPicks = action.on;
      return;
    case "challenge":
      return challengeResult(ctx, actor, action);
    case "decide":
      return decideMarket(ctx, actor, action);
  }
}

function requireViewer(game: Game, actor: Actor, what: string) {
  if (isStaff(game, actor.wallet)) throw new GameError(`Streamers and mods can't ${what} on their own coin`);
}

function requireStaff(game: Game, actor: Actor) {
  if (!isStaff(game, actor.wallet)) throw new GameError("Only the streamer or a mod can do that");
}

function requireLaunchesLeft(game: Game) {
  if (game.launched >= MAX_PREDICTIONS_PER_STREAM) throw new GameError(`This stream has had its ${MAX_PREDICTIONS_PER_STREAM} predictions`);
}

/** A suggestion in the queue (one still under review is hidden from everyone but its asker). */
function findSuggestion(game: Game, id: string) {
  const s = game.suggestions.find((x) => x.id === id && !x.review);
  if (!s) throw new GameError("That suggestion is gone");
  return s;
}

function cleanedOrThrow(text: unknown) {
  const cleaned = cleanQuestion(text);
  if (!cleaned.ok) throw new GameError(cleaned.error);
  return cleaned.question;
}

function suggest(ctx: Ctx, actor: Actor, text: string) {
  const { game, now } = ctx;
  requireViewer(game, actor, "suggest");
  if (!actor.holder) throw new GameError(`Hold at least ${MIN_HOLDING_COINS} of this coin to suggest`);
  requireLaunchesLeft(game);
  if (game.suggestions.some((s) => s.asker === actor.wallet)) throw new GameError("You already have a suggestion waiting");
  // A wallet whose question was just not approved waits until its note expires (NOTICE_MS): no review spam.
  if (game.notices.some((n) => n.to === actor.wallet)) throw new GameError("Your last question wasn't approved. Try again in a few minutes.");
  if (game.suggestions.length >= MAX_QUEUE) throw new GameError("The queue is full. Try again soon.");
  const question = cleanedOrThrow(text);
  if (actor.balance < SUGGEST_COST) throw new GameError(`Suggesting costs ${SUGGEST_COST} points`);
  ctx.debit(actor.wallet, SUGGEST_COST, SUGGEST_COST);
  game.suggestions.push({ id: String(game.nextId++), text: question, asker: actor.wallet, at: now, upvoters: [], extra: [], upvotes: 0, review: { tries: 0, at: now } });
}

function upvote({ game }: Ctx, actor: Actor, id: string) {
  requireViewer(game, actor, "upvote");
  if (!actor.holder) throw new GameError(`Hold at least ${MIN_HOLDING_COINS} of this coin to upvote`);
  const s = findSuggestion(game, id);
  if (s.asker === actor.wallet) throw new GameError("You can't upvote your own suggestion");
  if (hasUpvoted(s, actor.wallet)) throw new GameError("You already upvoted this");
  if (s.upvotes >= MAX_UPVOTES) throw new GameError("Upvotes are full");
  if (s.upvoters.length < MAX_UPVOTERS_STORED) s.upvoters.push(actor.wallet);
  else s.extra.push(upvoteFingerprint(actor.wallet));
  s.upvotes += 1;
}

/** A live prediction by id. */
const findLive = (game: Game, id: string) => game.live.find((p) => p.id === id);

/**
 * "At most half your points" is checked on the balance at bet time, which already counts this
 * wallet's bets on the other live predictions; the store re-checks it atomically.
 */
function bet(ctx: Ctx, actor: Actor, { id, side, amount }: ActionOf<"bet">) {
  const { game, now } = ctx;
  requireViewer(game, actor, "bet");
  const p = findLive(game, id);
  if (!p || now >= p.lockAt) throw new GameError("Betting is closed");
  if (!Number.isInteger(amount) || amount < MIN_BET || amount > MAX_BET) throw new GameError(`Bet ${MIN_BET} to ${MAX_BET} points`);
  const mine = p.bets[actor.wallet];
  if (!mine && p.bettors >= MAX_BETTORS) throw new GameError("This prediction is full");
  if (mine && mine.side !== side) throw new GameError(`You bet ${mine.side.toUpperCase()}; you can add to it, not switch`);
  if ((mine?.amount ?? 0) + amount > MAX_BET) throw new GameError(`At most ${MAX_BET} points on one prediction`);
  const minBalance = amount * BALANCE_PER_BET_POINT;
  if (minBalance > actor.balance) throw new GameError("You can bet at most half your points");
  ctx.debit(actor.wallet, amount, minBalance); // the store re-checks "at most half" atomically
  p.bets[actor.wallet] = { side, amount: (mine?.amount ?? 0) + amount, eligible: Boolean(mine?.eligible) || actor.eligible };
  p[side] += amount;
  p.bettors = Object.keys(p.bets).length;
}

function launchByStaff(ctx: Ctx, actor: Actor, action: ActionOf<"launch">) {
  const { game } = ctx;
  requireStaff(game, actor);
  if (game.live.length >= MAX_LIVE) throw new GameError(`${MAX_LIVE} predictions are already live`);
  if (game.pending) throw new GameError("A question is under review");
  requireLaunchesLeft(game);
  // The betting window is always the AI review's (else the default), never the client's.
  if (action.id !== undefined) {
    const s = findSuggestion(game, action.id);
    return launch(ctx, s, actor.wallet, s.windowMin ?? DEFAULT_WINDOW_MIN);
  }
  // A typed question goes live only once its review approves it.
  let source: string | undefined;
  if (action.source !== undefined && action.source !== "") {
    source = cleanLink(action.source) ?? undefined;
    if (!source) throw new GameError("The source must be an http(s) link");
  }
  game.pending = {
    id: String(game.nextId++),
    text: cleanedOrThrow(action.text),
    by: actor.wallet,
    at: ctx.now,
    review: { tries: 0, at: ctx.now },
    ...(source ? { source } : {}),
  };
}

/** A question staff may decide by hand: one whose every review check failed. */
function stuckItem(game: Game, id: string): ReviewTarget | null {
  const s = game.suggestions.find((x) => x.id === id && x.review && reviewStuck(x.review));
  if (s) return s;
  return game.pending?.id === id && reviewStuck(game.pending.review) ? game.pending : null;
}

function removeSuggestion(ctx: Ctx, actor: Actor, id: string) {
  const { game } = ctx;
  requireStaff(game, actor);
  const stuck = stuckItem(game, id);
  if (stuck) return rejectReview(ctx, stuck, "Your question wasn't approved: the streamer removed it.", true);
  const s = findSuggestion(game, id);
  game.suggestions = game.suggestions.filter((x) => x !== s); // its 10 points are spent, as on expiry
}

function approveByHand(ctx: Ctx, actor: Actor, id: string) {
  requireStaff(ctx.game, actor);
  const stuck = stuckItem(ctx.game, id);
  if (!stuck) throw new GameError("That question is still being checked");
  approveReview(ctx, stuck);
}

/**
 * The memestream oracle, by hand: an admin may always resolve once betting closed, even while the AI
 * referee works, but never on a coin they stream or mod. Markets then go through the challenge window.
 */
function resolve(ctx: Ctx, actor: Actor, { id, outcome }: ActionOf<"resolve">) {
  const { game, now, env } = ctx;
  if (!env.admins?.includes(actor.wallet)) throw new GameError("Only the memestream oracle (an admin) resolves predictions");
  if (isStaff(game, actor.wallet)) throw new GameError("Admins can't resolve predictions on a coin they stream or mod");
  const p = findLive(game, id);
  if (!p) throw new GameError("Nothing to resolve");
  if (now < p.lockAt) throw new GameError("Betting is still open");
  if (Object.hasOwn(p.bets, actor.wallet)) throw new GameError("You have a bet on this one, so you can't resolve it");
  // No points bet is not proof of no stake: the market's shares are read on chain too.
  if (hasMarket(p) && actor.shares) throw new GameError("You hold shares of this market, so you can't resolve it");
  settle(ctx, p, outcome, actor.wallet);
}

/**
 * The streamer or a mod says what happened (YES or NO, with an optional note), once betting closed
 * and until the result is final. Once the AI referee couldn't tell (or the coin has no AI), this is
 * the decision: it resolves the prediction as an admin's resolve would, unless they bet on it or hold
 * its market's shares (then an admin decides). On a market it is only a proposal: an admin settles
 * it. Before that it only informs the admin, and can be changed.
 */
function witness(ctx: Ctx, actor: Actor, { id, outcome, note }: ActionOf<"witness">) {
  const { game, now, env } = ctx;
  requireStaff(game, actor);
  const live = findLive(game, id);
  const done = live ? null : game.resolved.find((x) => x.id === id);
  const target = live ?? done;
  if (!target) throw new GameError("Nothing to answer");
  if (live && now < live.lockAt) throw new GameError("Betting is still open");
  if (done && (!done.market || done.market.step !== "open" || marketFinal(done, now, env) !== null)) throw new GameError("This result is already final");
  const cleaned = note?.trim().replace(/\s+/g, " ").slice(0, WITNESS_NOTE_MAX);
  const said: Witness = { outcome, by: actor.wallet, at: now, ...(cleaned ? { note: cleaned } : {}) };
  if (live && refereeState(live, now, env) === "unclear") {
    if (Object.hasOwn(live.bets, actor.wallet)) throw new GameError("You have a bet on this one, so an admin decides it");
    if (hasMarket(live) && actor.shares) throw new GameError("You hold shares of this market, so an admin decides it");
    live.witness = said;
    return settle(ctx, live, outcome, actor.wallet, undefined, refereeWhy(live, env) ?? "unclear");
  }
  target.witness = said;
}

function flagResult({ game, now }: Ctx, actor: Actor, id: string) {
  const p = game.resolved.find((x) => x.id === id);
  // A result held open for its AI check takes no flags past its window.
  if (!p || !p.open || now >= p.resolvedAt + FLAG_WINDOW_MS) throw new GameError("Too late to flag");
  if (!Object.hasOwn(p.open.results, actor.wallet)) throw new GameError("Only its bettors can flag a result");
  const mine = p.open.results[actor.wallet];
  if (mine[2]) throw new GameError("You already flagged this");
  mine[2] = 1;
  p.flags += 1;
  // Flags only add a reason: an AI check's disagree stays, whatever the flag count.
  p.disputed ||= p.flags * 100 >= DISPUTE_PERCENT * p.bettors;
}

function changeMods({ game }: Ctx, actor: Actor, { wallet, add }: ActionOf<"mod">) {
  if (actor.wallet !== game.creator) throw new GameError("Only the streamer can change mods");
  if (!add) {
    game.mods = game.mods.filter((m) => m !== wallet);
    return;
  }
  if (wallet === game.creator || game.mods.includes(wallet)) return;
  if (game.mods.length >= MAX_MODS) throw new GameError(`At most ${MAX_MODS} mods`);
  if (game.live.some((p) => Object.hasOwn(p.bets, wallet))) throw new GameError("That wallet has a bet on a live prediction");
  if (actor.modShares) throw new GameError("That wallet holds shares of one of this coin's markets");
  game.mods.push(wallet);
}

/**
 * A holder challenges the proposal (YES, NO or a cancel) during its window, once per
 * market, posting CHALLENGE_BOND points. The market then waits for an admin's decision.
 */
function challengeResult(ctx: Ctx, actor: Actor, { id, reason, link }: ActionOf<"challenge">) {
  const { game, now, env } = ctx;
  const p = game.resolved.find((x) => x.id === id);
  const m = p?.market;
  if (!p || !m || m.step !== "open") throw new GameError("This result has no market to challenge");
  requireViewer(game, actor, "challenge");
  if (m.decision) throw new GameError("This result is already decided");
  if (now >= challengeEndsAt(p, env)) throw new GameError("The challenge window is over");
  if (m.challenge) throw new GameError("This result is already challenged");
  if (!actor.shares) throw new GameError("Only holders of this market's shares can challenge");
  const cleaned = cleanReason(reason);
  if (!cleaned.ok) throw new GameError(cleaned.error);
  let evidence: string | undefined;
  if (link !== undefined && link !== "") {
    evidence = cleanLink(link) ?? undefined;
    if (!evidence) throw new GameError("The link must be an http(s) link");
  }
  if (actor.balance < CHALLENGE_BOND) throw new GameError(`A challenge needs a ${CHALLENGE_BOND}-point bond`);
  ctx.debit(actor.wallet, CHALLENGE_BOND, CHALLENGE_BOND);
  m.challenge = { by: actor.wallet, at: now, reason: cleaned.reason, ...(evidence ? { link: evidence } : {}), bond: CHALLENGE_BOND };
}

/**
 * An admin (never the coin's own streamer or a mod, never the challenger) settles a market that waits for one, once, with its final
 * outcome. A challenger's bond follows from it: the proposal upheld, the bond is lost; a refund, the
 * bond comes back; the other side, the bond comes back plus OVERTURN_REWARD.
 */
function decideMarket(ctx: Ctx, actor: Actor, { id, outcome }: ActionOf<"decide">) {
  const { game, now, env } = ctx;
  if (!env.admins?.includes(actor.wallet)) throw new GameError("Only a memestream admin can decide a market");
  // Never on their own coin (streamer or mod), and never on a challenge they made.
  if (isStaff(game, actor.wallet)) throw new GameError("Admins can't decide markets on a coin they stream or mod");
  const p = game.resolved.find((x) => x.id === id);
  const m = p?.market;
  if (!p || !m || m.step !== "open" || (!m.challenge && !needsAdmin(p))) throw new GameError("Nothing to decide");
  if (m.challenge?.by === actor.wallet) throw new GameError("Admins can't decide a challenge they made");
  if (actor.shares) throw new GameError("You hold shares of this market, so you can't decide it");
  if (m.decision) throw new GameError("This market is already decided");
  m.decision = { outcome, by: actor.wallet, at: now };
  const c = m.challenge;
  if (!c || outcome === proposedOutcome(p)) return;
  ctx.credit(c.by, outcome === "refund" ? c.bond : c.bond + OVERTURN_REWARD);
}
