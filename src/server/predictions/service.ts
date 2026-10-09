/**
 * Predictions service: ties identity (session tokens), the pure game engine and the atomic store
 * together. Every write reads the documents it needs, runs the engine, and commits the result in
 * one atomic step; if another request committed first ("conflict"), it re-reads and tries again.
 * Dependencies are passed in, so tests run it against the in-memory store with a fake clock.
 */
import { MESSAGE_TTL_MS } from "@/lib/predictions/message";
import { type Action, apply, type Game, GameError, newGame, type Prediction } from "@/lib/predictions/engine";
import { AUTO_CANCEL_MS, MAX_PREDICTIONS_PER_STREAM, type Outcome, type Side, STARTER_AFTER_MS, SUGGEST_TTL_MS } from "@/lib/predictions/rules";
import { heartbeat, isEligible, newProfile, onLeaderboard, type Profile } from "@/lib/predictions/watch";
import { issueToken, verifySessionMessage } from "./identity";
import type { Leader, PredictionStore } from "./store";

export type ServiceDeps = {
  store: PredictionStore;
  now: () => number;
  secret: string;
  /** The coin's streamer (creator wallet), or null if it isn't a memestream coin. */
  creatorOf: (mint: string) => Promise<string | null>;
  /** Commit attempts before answering "busy", and the pause between them. */
  attempts?: number;
  backoffMs?: () => number;
};

/** Too many concurrent writers on one coin: the caller should answer "busy, try again". */
export class ContentionError extends Error {}
/** Not a memestream coin. */
export class UnknownCoinError extends Error {}

const coinKey = (mint: string) => `coin:${mint}`;
const watchKey = (wallet: string) => `watch:${wallet}`;
const LEADER_CANDIDATES = 50;

export type Standing = { points: number; rank: number | null };
export type PredictionsView = {
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
  leaderboard: { stream: Leader[]; allTime: Leader[]; me: { stream: Standing | null; allTime: Standing | null } };
};

export function predictionsService(deps: ServiceDeps) {
  const { store, now } = deps;
  const attempts = deps.attempts ?? 12;
  const pause = () => new Promise((resolve) => setTimeout(resolve, deps.backoffMs?.() ?? 5 + Math.random() * 40));

  async function creator(mint: string) {
    const wallet = await deps.creatorOf(mint);
    if (!wallet) throw new UnknownCoinError("Coin not found");
    return wallet;
  }

  const parseGame = (json: string | null, streamer: string): Game => {
    const game: Game = json ? JSON.parse(json) : newGame(streamer);
    game.creator = streamer;
    return game;
  };
  const parseProfile = (json: string | null): Profile => (json ? JSON.parse(json) : newProfile());

  /** Signs a wallet in: checks its signed message, uses the nonce once, returns a session token. */
  async function session(message: string, signature: string) {
    const t = now();
    const verified = verifySessionMessage(message, signature, t);
    if (!verified.ok) throw new GameError(verified.error);
    const { wallet, nonce } = verified.request;
    const used = await store.commit({ docs: [], moves: [], won: [], nonce: { key: `nonce:${wallet}:${nonce}`, ttlMs: MESSAGE_TTL_MS * 2 } });
    if (used === "replay") throw new GameError("That signature was already used. Sign in again.");
    return { wallet, ...issueToken(wallet, t, deps.secret) };
  }

  /** One minute watched (if not too soon after the last), with its points. */
  async function beat(wallet: string) {
    for (let i = 0; i < attempts; i++) {
      const [doc] = await store.read([watchKey(wallet)]);
      const result = heartbeat(parseProfile(doc.json), now());
      if (!result.accepted) return { accepted: false, points: 0 };
      const moves = result.points > 0 ? [{ wallet, delta: result.points, floor: 0 }] : [];
      const status = await store.commit({ docs: [{ key: watchKey(wallet), v: doc.v, json: JSON.stringify(result.profile) }], moves, won: [] });
      if (status === "ok") return { accepted: true, points: result.points };
      await pause();
    }
    throw new ContentionError("Busy, try again");
  }

  /** A signed-in wallet's action on a coin's game. */
  async function act(mint: string, wallet: string, action: Action): Promise<PredictionsView> {
    const streamer = await creator(mint);
    for (let i = 0; i < attempts; i++) {
      const [coinDoc, watchDoc] = await store.read([coinKey(mint), watchKey(wallet)]);
      const [balance] = await store.balances([wallet]);
      const game = parseGame(coinDoc.json, streamer);
      const eligible = isEligible(parseProfile(watchDoc.json));
      const result = apply(game, action, { wallet, eligible, balance }, now());
      const status = await store.commit({
        docs: [{ key: coinKey(mint), v: coinDoc.v, json: JSON.stringify(result.game) }],
        moves: [...result.moves].map(([w, m]) => ({ wallet: w, delta: m.delta, floor: m.floor })),
        won: [...result.won].map(([w, delta]) => ({ wallet: w, delta })),
      });
      if (status === "ok") return view(mint, wallet);
      if (status === "insufficient") throw new GameError(action.kind === "bet" ? "You can bet at most half your points" : "Not enough points");
      await pause();
    }
    throw new ContentionError("Busy, try again");
  }

  /** Runs the clock (expiry, auto-cancel, auto-launch), saving it if anything was due. */
  async function ticked(mint: string, streamer: string): Promise<Game> {
    for (let i = 0; i < 3; i++) {
      const [doc] = await store.read([coinKey(mint)]);
      const game = parseGame(doc.json, streamer);
      const result = apply(game, { kind: "tick" }, null, now());
      if (!result.changed) return game;
      const status = await store.commit({
        docs: [{ key: coinKey(mint), v: doc.v, json: JSON.stringify(result.game) }],
        moves: [...result.moves].map(([w, m]) => ({ wallet: w, delta: m.delta, floor: m.floor })),
        won: [...result.won].map(([w, delta]) => ({ wallet: w, delta })),
      });
      if (status === "ok") return result.game;
    }
    // Others are saving the same tick; show what's stored.
    const [doc] = await store.read([coinKey(mint)]);
    return parseGame(doc.json, streamer);
  }

  /** Only wallets with 30+ minutes watched appear on leaderboards. */
  async function eligibleLeaders(candidates: Leader[]): Promise<Leader[]> {
    if (candidates.length === 0) return [];
    const docs = await store.read(candidates.map((c) => watchKey(c.wallet)));
    return candidates.filter((_, i) => onLeaderboard(docs[i].json ? (JSON.parse(docs[i].json!) as Profile) : null));
  }

  const standing = (board: Leader[], wallet: string, fallback: number | undefined): Standing | null => {
    const at = board.findIndex((l) => l.wallet === wallet);
    if (at >= 0) return { points: board[at].points, rank: at + 1 };
    return fallback === undefined ? null : { points: fallback, rank: null };
  };

  async function view(mint: string, wallet: string | null): Promise<PredictionsView> {
    const streamer = await creator(mint);
    const game = await ticked(mint, streamer);
    const t = now();

    const streamCandidates = Object.entries(game.won)
      .map(([w, points]) => ({ wallet: w, points }))
      .sort((a, b) => b.points - a.points || (a.wallet < b.wallet ? -1 : 1))
      .slice(0, LEADER_CANDIDATES);
    const [streamBoard, allTimeBoard] = await Promise.all([eligibleLeaders(streamCandidates), store.topWon(LEADER_CANDIDATES).then(eligibleLeaders)]);

    let me: PredictionsView["me"] = null;
    if (wallet) {
      const [[balance], [watchDoc]] = await Promise.all([store.balances([wallet]), store.read([watchKey(wallet)])]);
      const profile = parseProfile(watchDoc.json);
      me = {
        wallet,
        balance,
        watchMinutes: Math.floor(profile.watchMs / 60_000),
        eligible: isEligible(profile),
        starterInMinutes: profile.starter ? null : Math.max(0, Math.ceil((STARTER_AFTER_MS - profile.watchMs) / 60_000)),
        role: wallet === game.creator ? "streamer" : game.mods.includes(wallet) ? "mod" : null,
        hasSuggestion: game.suggestions.some((s) => s.asker === wallet),
      };
    }

    const roleOf = (by: string | null): PredictionsView["resolved"][number]["resolvedBy"] =>
      by === "auto" || by === null ? { role: "auto", wallet: null } : { role: by === game.creator ? "streamer" : "mod", wallet: by };
    const myResult = (p: Prediction) => {
      const bet = wallet ? p.bets[wallet] : undefined;
      if (!wallet || !bet || !p.payouts) return null;
      return { side: bet.side, bet: bet.amount, payout: p.payouts[wallet] ?? 0, flagged: p.flags.includes(wallet) };
    };

    return {
      now: t,
      launched: game.launched,
      maxPerStream: MAX_PREDICTIONS_PER_STREAM,
      me,
      live: game.live && {
        id: game.live.id,
        text: game.live.text,
        launchedAt: game.live.launchedAt,
        lockAt: game.live.lockAt,
        autoCancelAt: game.live.lockAt + AUTO_CANCEL_MS,
        yes: game.live.yes,
        no: game.live.no,
        bettors: game.live.bettors,
        myBet: wallet && game.live.bets[wallet] ? { side: game.live.bets[wallet].side, amount: game.live.bets[wallet].amount } : null,
      },
      queue: [...game.suggestions]
        .sort((a, b) => b.upvoters.length - a.upvoters.length || a.at - b.at)
        .map((s) => ({
          id: s.id,
          text: s.text,
          upvotes: s.upvoters.length,
          expiresAt: s.at + SUGGEST_TTL_MS,
          mine: s.asker === wallet,
          upvoted: wallet !== null && s.upvoters.includes(wallet),
        })),
      resolved: game.resolved.map((p) => ({
        id: p.id,
        text: p.text,
        outcome: p.outcome!,
        resolvedAt: p.resolvedAt!,
        resolvedBy: roleOf(p.resolvedBy),
        disputed: p.disputed,
        my: myResult(p),
      })),
      mods: game.mods,
      leaderboard: {
        // The top line shows winners only; a wallet's own standing can be below zero.
        stream: streamBoard.filter((l) => l.points > 0).slice(0, 3),
        allTime: allTimeBoard.filter((l) => l.points > 0).slice(0, 3),
        me: {
          stream: wallet ? standing(streamBoard, wallet, game.won[wallet]) : null,
          allTime: wallet ? standing(allTimeBoard, wallet, undefined) : null,
        },
      },
    };
  }

  return { session, beat, act, view };
}

export type PredictionsService = ReturnType<typeof predictionsService>;
