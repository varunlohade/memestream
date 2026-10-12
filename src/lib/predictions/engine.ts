/**
 * One coin's predictions game, as pure functions: (state, action, now) -> new state plus the point
 * movements it causes. No I/O, so every rule is unit-tested here; the store then commits the new
 * state and the point movements in one atomic step (and refuses if anything changed meanwhile).
 *
 * Flow: holders of the coin suggest YES/NO questions (10 points, back when it goes live) and
 * upvote them (free). While the streamer is watching their own coin (heartbeat in the last
 * 5 minutes) and "Crowd picks questions" is on, the top suggestion with 3+ upvotes goes live by
 * itself when nothing is live; the streamer or a mod can also launch one, or their own question.
 * One live prediction at a time, 20 per stream. Viewers bet on a side until it locks; the streamer
 * or a mod resolves YES/NO/Cancel; winners split the losing pool (parimutuel, no house fee).
 * A result counts for leaderboards and the asker reward only after its flag window, if not disputed.
 */
import {
  AI_CHECK_MAX_TRIES,
  AI_CHECK_RETRY_MS,
  ASKER_REWARD,
  ASKER_REWARD_MIN_BETTORS,
  AUTO_CANCEL_CROWD_MS,
  AUTO_CANCEL_MS,
  AUTO_LAUNCH_UPVOTES,
  BET_WINDOWS_MIN,
  byPoints,
  cleanQuestion,
  DEFAULT_WINDOW_MIN,
  DISPUTE_PERCENT,
  FLAG_WINDOW_MS,
  FRAME_NOTE_MAX,
  MAX_BET,
  MAX_BETTORS,
  MAX_HISTORY,
  MAX_MODS,
  MAX_NOTICES,
  MAX_PREDICTIONS_PER_STREAM,
  MAX_QUEUE,
  MAX_UPVOTERS_STORED,
  MAX_UPVOTES,
  MAX_WON_ENTRIES,
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
};
/** An AI review in progress: checks started so far, and when the last one started. */
export type Review = { tries: number; at: number };
/** A question the streamer or a mod typed, waiting for its review before it goes live. */
export type PendingLaunch = { id: string; text: string; by: string; windowMin: number; at: number; review: Review };
/** A short note for one wallet (or every staff wallet, `to: STAFF`) until `until`. */
export type Notice = { to: string; text: string; until: number };
export type BetRecord = { side: Side; amount: number; eligible: boolean };
/** When a stream frame is grabbed for the AI check. */
export type FrameKind = "launch" | "lock" | "resolve";
/** A frame grabbed at `at`, as a short description (null: not described yet, or no frame). Never the image. */
export type FrameNote = { kind: FrameKind; at: number; text: string | null };
/** The AI check's second opinion on the streamer's result. */
export type AiVerdict = "agree" | "disagree" | "unclear";
/** An AI check waiting for its verdict: runs started so far, when the last one started, the frames grabbed earlier. */
export type AiCheck = { tries: number; at: number; frames: FrameNote[] };
/** The prediction that is live now: open for bets until `lockAt`, then waiting for a result. */
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
  /** Frames grabbed for the AI check (only on a coin whose stream has frames, with the check set up). */
  frames?: FrameNote[];
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
  /** "auto" (nobody resolved in time) or the streamer/mod wallet that resolved it. */
  resolvedBy: string;
  askerReward: number;
  flags: number;
  disputed: boolean;
  open: FlagWindow | null;
  /** The AI check's verdict; absent if no check ran. */
  ai?: { verdict: AiVerdict; at: number };
  /** Present while the AI check runs; the result counts only after it ends. */
  check?: AiCheck;
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
  live: Prediction | null;
  /** Results, newest first: the last MAX_HISTORY, plus any still in their flag window. */
  resolved: Summary[];
  /** Net points won from bets on this stream, per wallet (top 100 only). */
  won: Record<string, number>;
  /** A staff question under review (at most one; nothing else launches meanwhile). */
  pending: PendingLaunch | null;
  /** "Not approved" notes, newest last. */
  notices: Notice[];
};

export type Action =
  | { kind: "tick" }
  | { kind: "suggest"; text: string }
  | { kind: "upvote"; id: string }
  | { kind: "bet"; side: Side; amount: number }
  | { kind: "launch"; id?: string; text?: string; windowMin?: number }
  | { kind: "remove"; id: string }
  | { kind: "approve"; id: string }
  | { kind: "resolve"; outcome: Outcome }
  | { kind: "flag"; id: string }
  | { kind: "mod"; wallet: string; add: boolean }
  | { kind: "crowd"; on: boolean };

/**
 * Who acts and what the server knows about them: watch-time eligibility, whether they hold the
 * coin (the sybil-resistant signal for suggesting and upvoting), and their current balance.
 */
export type Actor = { wallet: string; eligible: boolean; holder: boolean; balance: number };
/**
 * Facts from outside the coin's document: when the streamer's own heartbeat last came in, and
 * when their current stream started (their first heartbeat after 2+ hours away).
 */
export type Env = {
  streamerSeenAt: number | null;
  streamStartedAt?: number | null;
  /** The coin's stream has frames and the AI check is set up (keys present). */
  aiCheck?: boolean;
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
  live: null,
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
export type ReviewVerdict = { approved: true } | { approved: false; text: string };

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
    if (verdict.approved) approveReview(ctx, target);
    else rejectReview(ctx, target, verdict.text, false);
  });
}

/** A frame to grab and describe for the live prediction. */
export type CaptureTarget = { id: string; text: string; kind: FrameKind };
/** A result to check: its question, the streamer's outcome, the frames grabbed before, and which run this is. */
export type CheckTarget = { id: string; text: string; outcome: Side; frames: FrameNote[]; tries: number };

const checkDue = (check: AiCheck, now: number) => check.tries < AI_CHECK_MAX_TRIES && (check.tries === 0 || now >= check.at + AI_CHECK_RETRY_MS);
const capturesFor = (live: Prediction, now: number): FrameKind[] =>
  (["launch", "lock"] as const).filter((kind) => (kind === "launch" || now >= live.lockAt) && !live.frames?.some((f) => f.kind === kind));
/** Whether a frame grab or an AI check is due now. */
export const aiDue = (game: Game, now: number, env: Env) =>
  (Boolean(env.aiCheck) && game.live !== null && capturesFor(game.live, now).length > 0) || game.resolved.some((p) => p.check && checkDue(p.check, now));

/**
 * Claims every due frame grab (launch; lock once betting closes) and AI check run, like
 * startReviews: committing this first means no other server starts the same one.
 */
export function startAi(state: Game, now: number, env: Env): Result & { captures: CaptureTarget[]; checks: CheckTarget[] } {
  const captures: CaptureTarget[] = [];
  const checks: CheckTarget[] = [];
  const result = run(state, now, env, ({ game }) => {
    const live = game.live;
    if (env.aiCheck && live) {
      for (const kind of capturesFor(live, now)) {
        live.frames = [...(live.frames ?? []), { kind, at: now, text: null }];
        captures.push({ id: live.id, text: live.text, kind });
      }
    }
    for (const p of game.resolved) {
      if (!p.check || !checkDue(p.check, now) || p.outcome === "cancel") continue;
      p.check = { ...p.check, tries: p.check.tries + 1, at: now };
      checks.push({ id: p.id, text: p.text, outcome: p.outcome, frames: p.check.frames, tries: p.check.tries });
    }
  });
  return { ...result, captures, checks };
}

/** A grabbed frame's description (null: no frame). Only fills a claimed, empty note; anything else is left alone. */
export function applyFrame(state: Game, target: CaptureTarget, text: string | null, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, ({ game }) => {
    const notes = game.live?.id === target.id ? game.live.frames : game.resolved.find((p) => p.id === target.id)?.check?.frames;
    const note = notes?.find((f) => f.kind === target.kind && f.text === null);
    if (note && text) note.text = text.slice(0, FRAME_NOTE_MAX);
  });
}

/**
 * The AI check's verdict on a result (null: no evidence, so no check). A disagree marks it
 * disputed, as bettors' flags do; since the result counts only after its check ends, a late
 * verdict still keeps it off the leaderboards and the asker reward. A result already checked is left alone.
 */
export function applyAiVerdict(state: Game, id: string, verdict: AiVerdict | null, now: number, env: Env = { streamerSeenAt: null }): Result {
  return run(state, now, env, ({ game }) => {
    const p = game.resolved.find((x) => x.id === id && x.check);
    if (!p) return;
    delete p.check;
    if (!verdict) return;
    p.ai = { verdict, at: now };
    if (verdict === "disagree") p.disputed = true;
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
  endStaleChecks(ctx);
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

function approveReview(ctx: Ctx, target: ReviewTarget) {
  const { game } = ctx;
  const s = game.suggestions.find((x) => x.id === target.id && x.text === target.text && x.review);
  if (s) {
    delete s.review;
    return;
  }
  const p = game.pending;
  if (!p || p.id !== target.id || p.text !== target.text) return;
  game.pending = null;
  if (game.live || game.launched >= MAX_PREDICTIONS_PER_STREAM) return notify(ctx, STAFF, "Not launched: no slot was free");
  launch(ctx, { id: p.id, text: p.text }, p.by, p.windowMin);
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
  if (ctx.game.live && ctx.now >= autoCancelAt(ctx.game.live)) settle(ctx, "cancel", AUTO);
}

/** An AI check whose every run failed (or never reported back) ends as "couldn't tell". */
function endStaleChecks({ game, now }: Ctx) {
  for (const p of game.resolved) {
    if (!p.check || p.check.tries < AI_CHECK_MAX_TRIES || now < p.check.at + AI_CHECK_RETRY_MS) continue;
    delete p.check;
    p.ai = { verdict: "unclear", at: now };
  }
}

/** Results past their flag window, with no AI check still running, count now (unless disputed); then only the last MAX_HISTORY stay. */
function closeFlagWindows(ctx: Ctx) {
  const { game, now } = ctx;
  for (const p of game.resolved) if (p.open && !p.check && now >= p.resolvedAt + FLAG_WINDOW_MS) finalize(ctx, p);
  game.resolved = game.resolved.filter((p, i) => p.open || i < MAX_HISTORY);
}

/** The crowd picks: only while the streamer is here and has crowd picks on. */
function launchCrowdPick(ctx: Ctx) {
  const { game, now } = ctx;
  if (game.live || game.pending || !game.crowdPicks || !streamerPresent(ctx.env, now) || game.launched >= MAX_PREDICTIONS_PER_STREAM) return;
  const top = [...game.suggestions]
    .filter((s) => !s.review && s.upvotes >= AUTO_LAUNCH_UPVOTES)
    .sort((a, b) => b.upvotes - a.upvotes || a.at - b.at || Number(a.id) - Number(b.id))[0];
  if (top) launch(ctx, top, CROWD, DEFAULT_WINDOW_MIN);
}

function launch(ctx: Ctx, from: Suggestion | { id?: string; text: string }, by: string, windowMin: number) {
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
  game.live = {
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
  };
}

/** Pays out at once; winnings for leaderboards and the asker reward wait for the flag window. */
function settle(ctx: Ctx, outcome: Outcome, by: string) {
  const { game, now } = ctx;
  const p = game.live!;
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
  game.live = null;
  const summary: Summary = { id, text, asker, outcome, yes, no, bettors, resolvedAt: now, resolvedBy: by, askerReward: 0, flags: 0, disputed: false, open: { results, eligible } };
  // A YES/NO result gets an AI check when the coin's stream has frames; a cancel needs none.
  if (outcome !== "cancel" && ctx.env.aiCheck) summary.check = { tries: 0, at: now, frames: p.frames ?? [] };
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
      return resolve(ctx, actor, action.outcome);
    case "flag":
      return flagResult(ctx, actor, action.id);
    case "mod":
      return changeMods(ctx, actor, action);
    case "crowd":
      requireStaff(ctx.game, actor);
      ctx.game.crowdPicks = action.on;
      return;
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
  if (!actor.eligible) throw new GameError("Watch 15 minutes to upvote");
  const s = findSuggestion(game, id);
  if (s.asker === actor.wallet) throw new GameError("You can't upvote your own suggestion");
  if (hasUpvoted(s, actor.wallet)) throw new GameError("You already upvoted this");
  if (s.upvotes >= MAX_UPVOTES) throw new GameError("Upvotes are full");
  if (s.upvoters.length < MAX_UPVOTERS_STORED) s.upvoters.push(actor.wallet);
  else s.extra.push(upvoteFingerprint(actor.wallet));
  s.upvotes += 1;
}

function bet(ctx: Ctx, actor: Actor, { side, amount }: ActionOf<"bet">) {
  const { game, now } = ctx;
  requireViewer(game, actor, "bet");
  const p = game.live;
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
  if (game.live) throw new GameError("A prediction is already live");
  if (game.pending) throw new GameError("A question is under review");
  requireLaunchesLeft(game);
  const windowMin = action.windowMin ?? DEFAULT_WINDOW_MIN;
  if (!(BET_WINDOWS_MIN as readonly number[]).includes(windowMin)) throw new GameError("Pick 1, 2, 5 or 10 minutes");
  if (action.id !== undefined) return launch(ctx, findSuggestion(game, action.id), actor.wallet, windowMin);
  // A typed question goes live only once its review approves it.
  game.pending = { id: String(game.nextId++), text: cleanedOrThrow(action.text), by: actor.wallet, windowMin, at: ctx.now, review: { tries: 0, at: ctx.now } };
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
  if (stuck) return rejectReview(ctx, stuck, "Not approved by the streamer", true);
  const s = findSuggestion(game, id);
  game.suggestions = game.suggestions.filter((x) => x !== s); // its 10 points are spent, as on expiry
}

function approveByHand(ctx: Ctx, actor: Actor, id: string) {
  requireStaff(ctx.game, actor);
  const stuck = stuckItem(ctx.game, id);
  if (!stuck) throw new GameError("That question is still being checked");
  approveReview(ctx, stuck);
}

function resolve(ctx: Ctx, actor: Actor, outcome: Outcome) {
  const { game, now } = ctx;
  requireStaff(game, actor);
  if (!game.live) throw new GameError("Nothing to resolve");
  if (now < game.live.lockAt) throw new GameError("Betting is still open");
  if (Object.hasOwn(game.live.bets, actor.wallet)) throw new GameError("You have a bet on this one, so you can't resolve it");
  settle(ctx, outcome, actor.wallet);
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
  p.disputed = p.flags * 100 >= DISPUTE_PERCENT * p.bettors;
}

function changeMods({ game }: Ctx, actor: Actor, { wallet, add }: ActionOf<"mod">) {
  if (actor.wallet !== game.creator) throw new GameError("Only the streamer can change mods");
  if (!add) {
    game.mods = game.mods.filter((m) => m !== wallet);
    return;
  }
  if (wallet === game.creator || game.mods.includes(wallet)) return;
  if (game.mods.length >= MAX_MODS) throw new GameError(`At most ${MAX_MODS} mods`);
  if (game.live && Object.hasOwn(game.live.bets, wallet)) throw new GameError("That wallet has a bet on the live prediction");
  game.mods.push(wallet);
}
