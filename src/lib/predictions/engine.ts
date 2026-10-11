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
  MAX_BET,
  MAX_BETTORS,
  MAX_HISTORY,
  MAX_MODS,
  MAX_PREDICTIONS_PER_STREAM,
  MAX_QUEUE,
  MAX_UPVOTERS_STORED,
  MAX_UPVOTES,
  MAX_WON_ENTRIES,
  MIN_BET,
  type Outcome,
  payouts,
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
};
export type BetRecord = { side: Side; amount: number; eligible: boolean };
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
  launched: number;
  suggestions: Suggestion[];
  live: Prediction | null;
  /** Results, newest first: the last MAX_HISTORY, plus any still in their flag window. */
  resolved: Summary[];
  /** Net points won from bets on this stream, per wallet (top 100 only). */
  won: Record<string, number>;
};

export type Action =
  | { kind: "tick" }
  | { kind: "suggest"; text: string }
  | { kind: "upvote"; id: string }
  | { kind: "bet"; side: Side; amount: number }
  | { kind: "launch"; id?: string; text?: string; windowMin?: number }
  | { kind: "remove"; id: string }
  | { kind: "resolve"; outcome: Outcome }
  | { kind: "flag"; id: string }
  | { kind: "mod"; wallet: string; add: boolean }
  | { kind: "crowd"; on: boolean };

/**
 * Who acts and what the server knows about them: watch-time eligibility, whether they hold the
 * coin (the sybil-resistant signal for suggesting and upvoting), and their current balance.
 */
export type Actor = { wallet: string; eligible: boolean; holder: boolean; balance: number };
/** Facts from outside the coin's document: when the streamer's own heartbeat last came in. */
export type Env = { streamerSeenAt: number | null };

/** A balance change: `delta` points, allowed only if the balance is at least `floor` before it. */
export type Movement = { delta: number; floor: number };
export type Result = { game: Game; moves: Map<string, Movement>; won: Map<string, number>; changed: boolean };

/** A rule said no; the message is safe to show the user. */
export class GameError extends Error {}

/** Characters of a wallet kept as an upvote fingerprint. */
const FINGERPRINT = 10;

export const newGame = (creator: string): Game => ({
  creator,
  mods: [],
  crowdPicks: true,
  nextId: 1,
  launched: 0,
  suggestions: [],
  live: null,
  resolved: [],
  won: {},
});

export const isStaff = (game: Game, wallet: string) => wallet === game.creator || game.mods.includes(wallet);
export const streamerPresent = (env: Env, now: number) => env.streamerSeenAt !== null && now - env.streamerSeenAt < STREAMER_PRESENT_MS;

/** Applies `action` by `actor` at `now`. Every action first runs the clock (expiry, auto-cancel, auto-launch). */
export function apply(state: Game, action: Action, actor: Actor | null, now: number, env: Env = { streamerSeenAt: null }): Result {
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
  if (action.kind !== "tick") {
    if (!actor) throw new GameError("Sign in to play");
    act(ctx, action, actor);
    tick(ctx); // a resolve or launch may free the slot for the next suggestion
  }
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
  const { game, now } = ctx;
  // Suggestions that didn't go live in 20 minutes expire; their 10 points are spent.
  game.suggestions = game.suggestions.filter((s) => now < s.at + SUGGEST_TTL_MS);
  // A locked prediction nobody resolved cancels by itself (crowd picks sooner): full refunds.
  if (game.live) {
    const limit = game.live.launchedBy === "crowd" ? AUTO_CANCEL_CROWD_MS : AUTO_CANCEL_MS;
    if (now >= game.live.lockAt + limit) settle(ctx, "cancel", "auto");
  }
  // Results past their flag window count now (unless disputed).
  for (const p of game.resolved) if (p.open && now >= p.resolvedAt + FLAG_WINDOW_MS) finalize(ctx, p);
  game.resolved = game.resolved.filter((p, i) => p.open || i < MAX_HISTORY);
  // The crowd picks: only while the streamer is here and has crowd picks on.
  if (!game.live && game.crowdPicks && streamerPresent(ctx.env, now) && game.launched < MAX_PREDICTIONS_PER_STREAM) {
    const top = [...game.suggestions]
      .filter((s) => s.upvotes >= AUTO_LAUNCH_UPVOTES)
      .sort((a, b) => b.upvotes - a.upvotes || a.at - b.at || Number(a.id) - Number(b.id))[0];
    if (top) launch(ctx, top, "crowd", DEFAULT_WINDOW_MIN);
  }
}

function launch(ctx: Ctx, from: Suggestion | { text: string }, by: string, windowMin: number) {
  const { game, now } = ctx;
  let id: string;
  let asker: string | null = null;
  if ("asker" in from) {
    game.suggestions = game.suggestions.filter((s) => s.id !== from.id);
    ctx.credit(from.asker, SUGGEST_COST); // the suggestion cost comes back when it goes live
    id = from.id;
    asker = from.asker;
  } else {
    id = String(game.nextId++);
  }
  game.launched += 1;
  game.live = {
    id,
    text: from.text,
    asker,
    launchedAt: now,
    lockAt: now + windowMin * 60_000,
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
    ctx.credit(b.wallet, paid.get(b.wallet) ?? 0);
    results[b.wallet] = [b.amount, paid.get(b.wallet) ?? 0, 0];
  }
  const eligible = Object.values(p.bets).filter((b) => b.eligible).length;
  const { id, text, asker, yes, no, bettors } = p;
  game.live = null;
  game.resolved.unshift({ id, text, asker, outcome, yes, no, bettors, resolvedAt: now, resolvedBy: by, askerReward: 0, flags: 0, disputed: false, open: { results, eligible } });
}

/** The flag window is over: the winnings count (unless disputed), the asker reward is settled, the lists go. */
function finalize(ctx: Ctx, p: Summary) {
  const { game } = ctx;
  const open = p.open!;
  p.open = null;
  if (p.disputed || p.outcome === "cancel") return;
  for (const [wallet, [stake, payout]] of Object.entries(open.results)) {
    const net = payout - stake;
    if (net === 0) continue;
    game.won[wallet] = (game.won[wallet] ?? 0) + net;
    ctx.won.set(wallet, (ctx.won.get(wallet) ?? 0) + net);
  }
  const top = Object.entries(game.won)
    .map(([wallet, points]) => ({ wallet, points }))
    .sort(byPoints)
    .slice(0, MAX_WON_ENTRIES);
  game.won = Object.fromEntries(top.map((l) => [l.wallet, l.points]));
  if (p.asker && open.eligible >= ASKER_REWARD_MIN_BETTORS) {
    p.askerReward = ASKER_REWARD;
    ctx.credit(p.asker, ASKER_REWARD);
  }
}

function act(ctx: Ctx, action: Exclude<Action, { kind: "tick" }>, actor: Actor) {
  const { game, now } = ctx;
  const staff = isStaff(game, actor.wallet);
  const viewerOnly = (what: string) => {
    if (staff) throw new GameError(`Streamers and mods can't ${what} on their own coin`);
  };
  const staffOnly = () => {
    if (!staff) throw new GameError("Only the streamer or a mod can do that");
  };
  const suggestion = (id: string) => {
    const s = game.suggestions.find((x) => x.id === id);
    if (!s) throw new GameError("That suggestion is gone");
    return s;
  };

  switch (action.kind) {
    case "suggest": {
      viewerOnly("suggest");
      if (!actor.holder) throw new GameError("Hold this coin to suggest");
      if (game.launched >= MAX_PREDICTIONS_PER_STREAM) throw new GameError("This stream has had its 20 predictions");
      if (game.suggestions.some((s) => s.asker === actor.wallet)) throw new GameError("You already have a suggestion waiting");
      if (game.suggestions.length >= MAX_QUEUE) throw new GameError("The queue is full. Try again soon.");
      const cleaned = cleanQuestion(action.text);
      if (!cleaned.ok) throw new GameError(cleaned.error);
      if (actor.balance < SUGGEST_COST) throw new GameError(`Suggesting costs ${SUGGEST_COST} points`);
      ctx.debit(actor.wallet, SUGGEST_COST, SUGGEST_COST);
      game.suggestions.push({ id: String(game.nextId++), text: cleaned.question, asker: actor.wallet, at: now, upvoters: [], extra: [], upvotes: 0 });
      return;
    }
    case "upvote": {
      viewerOnly("upvote");
      if (!actor.holder) throw new GameError("Hold this coin to upvote");
      if (!actor.eligible) throw new GameError("Watch 15 minutes to upvote");
      const s = suggestion(action.id);
      if (s.asker === actor.wallet) throw new GameError("You can't upvote your own suggestion");
      const print = actor.wallet.slice(0, FINGERPRINT);
      if (s.upvoters.includes(actor.wallet) || s.extra.includes(print)) throw new GameError("You already upvoted this");
      if (s.upvotes >= MAX_UPVOTES) throw new GameError("Upvotes are full");
      if (s.upvoters.length < MAX_UPVOTERS_STORED) s.upvoters.push(actor.wallet);
      else s.extra.push(print);
      s.upvotes += 1;
      return;
    }
    case "bet": {
      viewerOnly("bet");
      const p = game.live;
      if (!p || now >= p.lockAt) throw new GameError("Betting is closed");
      const { side, amount } = action;
      if (!Number.isInteger(amount) || amount < MIN_BET || amount > MAX_BET) throw new GameError(`Bet ${MIN_BET} to ${MAX_BET} points`);
      const mine = p.bets[actor.wallet];
      if (!mine && p.bettors >= MAX_BETTORS) throw new GameError("This prediction is full");
      if (mine && mine.side !== side) throw new GameError(`You bet ${mine.side.toUpperCase()}; you can add to it, not switch`);
      if ((mine?.amount ?? 0) + amount > MAX_BET) throw new GameError(`At most ${MAX_BET} points on one prediction`);
      if (amount * 2 > actor.balance) throw new GameError("You can bet at most half your points");
      ctx.debit(actor.wallet, amount, amount * 2); // the store re-checks "at most half" atomically
      p.bets[actor.wallet] = { side, amount: (mine?.amount ?? 0) + amount, eligible: Boolean(mine?.eligible) || actor.eligible };
      p[side] += amount;
      p.bettors = Object.keys(p.bets).length;
      return;
    }
    case "launch": {
      staffOnly();
      if (game.live) throw new GameError("A prediction is already live");
      if (game.launched >= MAX_PREDICTIONS_PER_STREAM) throw new GameError("This stream has had its 20 predictions");
      const windowMin = action.windowMin ?? DEFAULT_WINDOW_MIN;
      if (!(BET_WINDOWS_MIN as readonly number[]).includes(windowMin)) throw new GameError("Pick 1, 2, 5 or 10 minutes");
      if (action.id !== undefined) return launch(ctx, suggestion(action.id), actor.wallet, windowMin);
      const cleaned = cleanQuestion(action.text);
      if (!cleaned.ok) throw new GameError(cleaned.error);
      return launch(ctx, { text: cleaned.question }, actor.wallet, windowMin);
    }
    case "remove": {
      staffOnly();
      const s = suggestion(action.id);
      game.suggestions = game.suggestions.filter((x) => x !== s); // its 10 points are spent, as on expiry
      return;
    }
    case "resolve": {
      staffOnly();
      if (!game.live) throw new GameError("Nothing to resolve");
      if (now < game.live.lockAt) throw new GameError("Betting is still open");
      return settle(ctx, action.outcome, actor.wallet);
    }
    case "flag": {
      const p = game.resolved.find((x) => x.id === action.id);
      if (!p || !p.open) throw new GameError("Too late to flag");
      if (!Object.hasOwn(p.open.results, actor.wallet)) throw new GameError("Only its bettors can flag a result");
      const mine = p.open.results[actor.wallet];
      if (mine[2]) throw new GameError("You already flagged this");
      mine[2] = 1;
      p.flags += 1;
      p.disputed = p.flags * 100 >= DISPUTE_PERCENT * p.bettors;
      return;
    }
    case "mod": {
      if (actor.wallet !== game.creator) throw new GameError("Only the streamer can change mods");
      if (!action.add) {
        game.mods = game.mods.filter((m) => m !== action.wallet);
        return;
      }
      if (action.wallet === game.creator || game.mods.includes(action.wallet)) return;
      if (game.mods.length >= MAX_MODS) throw new GameError(`At most ${MAX_MODS} mods`);
      game.mods.push(action.wallet);
      return;
    }
    case "crowd": {
      staffOnly();
      game.crowdPicks = action.on;
      return;
    }
  }
}
