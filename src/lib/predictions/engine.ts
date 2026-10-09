/**
 * One coin's predictions game, as pure functions: (state, action, now) -> new state plus the point
 * movements it causes. No I/O, so every rule is unit-tested here; the store then commits the new
 * state and the point movements in one atomic step (and refuses if anything changed meanwhile).
 *
 * Flow: viewers suggest YES/NO questions (10 points, back when it goes live) and upvote them
 * (free, eligible watchers only). When nothing is live, the top suggestion with 3+ upvotes goes
 * live by itself; the streamer or a mod can also launch one, or their own question. One live
 * prediction at a time, 20 per stream. Viewers bet on a side until it locks; the streamer or a mod
 * resolves YES/NO/Cancel; winners split the losing pool (parimutuel, no house fee).
 */
import {
  ASKER_REWARD,
  ASKER_REWARD_MIN_BETTORS,
  AUTO_CANCEL_MS,
  AUTO_LAUNCH_UPVOTES,
  BET_WINDOWS_MIN,
  cleanQuestion,
  DEFAULT_WINDOW_MIN,
  DISPUTE_PERCENT,
  MAX_BET,
  MAX_MODS,
  MAX_PREDICTIONS_PER_STREAM,
  MIN_BET,
  type Outcome,
  payouts,
  type Side,
  SUGGEST_COST,
  SUGGEST_TTL_MS,
} from "./rules";

export type Suggestion = { id: string; text: string; asker: string; at: number; upvoters: string[] };
export type BetRecord = { side: Side; amount: number; eligible: boolean };
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
  outcome: Outcome | null;
  resolvedAt: number | null;
  /** "auto" (nobody resolved in time) or the streamer/mod wallet that resolved it. */
  resolvedBy: string | null;
  payouts: Record<string, number> | null;
  askerReward: number;
  flags: string[];
  disputed: boolean;
  bettors: number;
};
export type Game = {
  creator: string;
  mods: string[];
  nextId: number;
  launched: number;
  suggestions: Suggestion[];
  live: Prediction | null;
  /** Resolved predictions, newest first. The newest few keep their bets (for payouts and flags). */
  resolved: Prediction[];
  /** Net points won from bets on this stream, per wallet. */
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
  | { kind: "mod"; wallet: string; add: boolean };

/** Who acts and what the server knows about them (watch-time eligibility, current balance). */
export type Actor = { wallet: string; eligible: boolean; balance: number };

/** A balance change: `delta` points, allowed only if the balance is at least `floor` before it. */
export type Movement = { delta: number; floor: number };
export type Result = { game: Game; moves: Map<string, Movement>; won: Map<string, number>; changed: boolean };

/** A rule said no; the message is safe to show the user. */
export class GameError extends Error {}

/** Resolved predictions that keep their bets and payouts. */
const KEEP_DETAILED = 5;

export const newGame = (creator: string): Game => ({ creator, mods: [], nextId: 1, launched: 0, suggestions: [], live: null, resolved: [], won: {} });

export const isStaff = (game: Game, wallet: string) => wallet === game.creator || game.mods.includes(wallet);

/** Applies `action` by `actor` at `now`. Every action first runs the clock (expiry, auto-cancel, auto-launch). */
export function apply(state: Game, action: Action, actor: Actor | null, now: number): Result {
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
  const ctx = { game, credit, debit, won, now };

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
  credit: (wallet: string, points: number) => void;
  debit: (wallet: string, points: number, floor: number) => void;
  won: Map<string, number>;
};

function tick(ctx: Ctx) {
  const { game, now } = ctx;
  // Suggestions that didn't go live in 20 minutes expire; their 10 points are spent.
  game.suggestions = game.suggestions.filter((s) => now < s.at + SUGGEST_TTL_MS);
  // A locked prediction nobody resolved in an hour cancels by itself: full refunds.
  if (game.live && now >= game.live.lockAt + AUTO_CANCEL_MS) settle(ctx, "cancel", "auto");
  // The crowd picks: when nothing is live, the top suggestion with enough upvotes goes live.
  if (!game.live && game.launched < MAX_PREDICTIONS_PER_STREAM) {
    const top = [...game.suggestions]
      .filter((s) => s.upvoters.length >= AUTO_LAUNCH_UPVOTES)
      .sort((a, b) => b.upvoters.length - a.upvoters.length || a.at - b.at || Number(a.id) - Number(b.id))[0];
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
    outcome: null,
    resolvedAt: null,
    resolvedBy: null,
    payouts: null,
    askerReward: 0,
    flags: [],
    disputed: false,
    bettors: 0,
  };
}

function settle(ctx: Ctx, outcome: Outcome, by: string) {
  const { game, now } = ctx;
  const p = game.live!;
  const bets = Object.entries(p.bets).map(([wallet, b]) => ({ wallet, side: b.side, amount: b.amount }));
  const paid = payouts(bets, outcome);
  for (const b of bets) {
    const payout = paid.get(b.wallet) ?? 0;
    ctx.credit(b.wallet, payout);
    const net = payout - b.amount;
    if (net !== 0) {
      game.won[b.wallet] = (game.won[b.wallet] ?? 0) + net;
      ctx.won.set(b.wallet, (ctx.won.get(b.wallet) ?? 0) + net);
    }
  }
  const eligibleBettors = Object.values(p.bets).filter((b) => b.eligible).length;
  if (outcome !== "cancel" && p.asker && eligibleBettors >= ASKER_REWARD_MIN_BETTORS) {
    p.askerReward = ASKER_REWARD;
    ctx.credit(p.asker, ASKER_REWARD);
  }
  Object.assign(p, { outcome, resolvedAt: now, resolvedBy: by, payouts: Object.fromEntries(paid) });
  game.live = null;
  game.resolved.unshift(p);
  // Older results keep their public record (question, outcome, time, resolver), not every bet.
  for (const old of game.resolved.slice(KEEP_DETAILED)) Object.assign(old, { bets: {}, payouts: null });
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
      if (game.launched >= MAX_PREDICTIONS_PER_STREAM) throw new GameError("This stream has had its 20 predictions");
      if (game.suggestions.some((s) => s.asker === actor.wallet)) throw new GameError("You already have a suggestion waiting");
      const cleaned = cleanQuestion(action.text);
      if (!cleaned.ok) throw new GameError(cleaned.error);
      if (actor.balance < SUGGEST_COST) throw new GameError(`Suggesting costs ${SUGGEST_COST} points`);
      ctx.debit(actor.wallet, SUGGEST_COST, SUGGEST_COST);
      game.suggestions.push({ id: String(game.nextId++), text: cleaned.question, asker: actor.wallet, at: now, upvoters: [] });
      return;
    }
    case "upvote": {
      viewerOnly("upvote");
      if (!actor.eligible) throw new GameError("Watch 15 minutes to upvote");
      const s = suggestion(action.id);
      if (s.asker === actor.wallet) throw new GameError("You can't upvote your own suggestion");
      if (s.upvoters.includes(actor.wallet)) throw new GameError("You already upvoted this");
      s.upvoters.push(actor.wallet);
      return;
    }
    case "bet": {
      viewerOnly("bet");
      const p = game.live;
      if (!p || now >= p.lockAt) throw new GameError("Betting is closed");
      const { side, amount } = action;
      if (!Number.isInteger(amount) || amount < MIN_BET || amount > MAX_BET) throw new GameError(`Bet ${MIN_BET} to ${MAX_BET} points`);
      const mine = p.bets[actor.wallet];
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
      if (!p || !p.payouts) throw new GameError("Too old to flag");
      if (!Object.hasOwn(p.payouts, actor.wallet)) throw new GameError("Only its bettors can flag a result");
      if (p.flags.includes(actor.wallet)) throw new GameError("You already flagged this");
      p.flags.push(actor.wallet);
      p.disputed = p.flags.length * 100 >= DISPUTE_PERCENT * Object.keys(p.payouts).length;
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
  }
}
