/**
 * Predictions service: ties identity (session tokens), the pure game engine and the atomic store
 * together. Every write reads the documents it needs, runs the engine, and commits the result in
 * one atomic step; if another request committed first ("conflict"), it re-reads and tries again.
 * Dependencies are passed in, so tests run it against the in-memory store with a fake clock.
 */
import { createHmac } from "node:crypto";
import { type Action, apply, type Env, type Game, GameError, newGame, type Summary } from "@/lib/predictions/engine";
import { MESSAGE_TTL_MS } from "@/lib/predictions/message";
import {
  AUTO_CANCEL_CROWD_MS,
  AUTO_CANCEL_MS,
  byPoints,
  FLAG_WINDOW_MS,
  MAX_EARNING_WALLETS_PER_IP,
  MAX_PREDICTIONS_PER_STREAM,
  STARTER_AFTER_MS,
  STREAM_GAP_MS,
  STREAMER_PRESENT_MS,
  SUGGEST_TTL_MS,
} from "@/lib/predictions/rules";
import type { LeaderRow, PredictionsView, Standing } from "@/lib/predictions/view";
import { heartbeat, isEligible, newProfile, onLeaderboard, type Profile, utcDay } from "@/lib/predictions/watch";
import { issueToken, verifySessionMessage, walletFromToken } from "./identity";
import type { Commit, PredictionStore } from "./store";

export type CoinFacts = { creator: string; status: "trading" | "graduating" | "graduated" };

export type ServiceDeps = {
  store: PredictionStore;
  now: () => number;
  secret: string;
  /** The site's host (e.g. "memestream.lol"); sign-in messages must name it. */
  domain: string;
  /** The coin's streamer and status, or null if it isn't a memestream coin (cached, budgeted read). */
  coin: (mint: string) => Promise<CoinFacts | null>;
  /** Whether `wallet` holds more than 0 of the coin (cached, budgeted read). */
  holds: (mint: string, wallet: string) => Promise<boolean>;
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
const presenceKey = (mint: string) => `presence:${mint}`;
/** The streamer's last heartbeat on their coin, and when this stream started (after 2+ hours away). */
type Presence = { at: number; since?: number };
const LEADER_CANDIDATES = 50;
const LEADERBOARD_CACHE_MS = 15_000;
const PUBLIC_VIEW_CACHE_MS = 1_500;
/** The GET response lists at most this many waiting suggestions and recent results. */
const QUEUE_SHOWN = 20;
const RESOLVED_SHOWN = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const movesOf = (result: ReturnType<typeof apply>) => ({
  moves: [...result.moves].map(([w, m]) => ({ wallet: w, delta: m.delta, floor: m.floor })),
  won: [...result.won].map(([w, delta]) => ({ wallet: w, delta })),
});

export function predictionsService(deps: ServiceDeps) {
  const { store, now } = deps;
  const attempts = deps.attempts ?? 12;
  const pause = () => new Promise((resolve) => setTimeout(resolve, deps.backoffMs?.() ?? 5 + Math.random() * 40));

  async function facts(mint: string) {
    const coin = await deps.coin(mint);
    if (!coin) throw new UnknownCoinError("Coin not found");
    return coin;
  }

  const parseGame = (json: string | null, streamer: string): Game => {
    const game: Game = json ? JSON.parse(json) : newGame(streamer);
    game.creator = streamer;
    return game;
  };
  const parseProfile = (json: string | null): Profile => (json ? JSON.parse(json) : newProfile());
  const parsePresence = (json: string | null): Presence | null => (json ? JSON.parse(json) : null);
  const parseEnv = (json: string | null): Env => {
    const presence = parsePresence(json);
    return { streamerSeenAt: presence?.at ?? null, streamStartedAt: presence?.since ?? null };
  };

  /** Signs a wallet in: checks its signed message (domain, expiry, signature), uses the nonce once, returns a session token. */
  async function session(message: string, signature: string) {
    const t = now();
    const verified = verifySessionMessage(message, signature, t, deps.domain);
    if (!verified.ok) throw new GameError(verified.error);
    const { wallet, nonce } = verified.request;
    const used = await store.commit({ docs: [], moves: [], won: [], nonce: { key: `nonce:${wallet}:${nonce}`, ttlMs: MESSAGE_TTL_MS * 2 } });
    if (used === "replay") throw new GameError("That signature was already used. Sign in again.");
    return { wallet, ...issueToken(wallet, t, deps.secret) };
  }

  /**
   * One minute watched on `mint` (if not too soon after the last). Counts only on a memestream
   * coin that is trading or graduated. Only the first 5 wallets from one IP each UTC day earn
   * points; later ones earn 0, silently. The streamer's own beat also marks them present.
   */
  async function beat(wallet: string, mint: string, ip: string) {
    const coin = await facts(mint);
    if (coin.status === "graduating") return { accepted: false, points: 0 };
    const t = now();
    // The IP is never stored, only a keyed hash of it.
    const ipKey = `ip:${createHmac("sha256", deps.secret).update(ip).digest("base64url").slice(0, 22)}:${utcDay(t)}`;
    const streamer = wallet === coin.creator;
    for (let i = 0; i < attempts; i++) {
      const [watchDoc, ipDoc, presenceDoc] = await store.read([watchKey(wallet), ipKey, presenceKey(mint)]);
      const wallets: string[] = ipDoc.json ? JSON.parse(ipDoc.json) : [];
      const earning = wallets.includes(wallet) || wallets.length < MAX_EARNING_WALLETS_PER_IP;
      const result = heartbeat(parseProfile(watchDoc.json), t, earning);
      if (!result.accepted) return { accepted: false, points: 0 };
      const docs: Commit["docs"] = [{ key: watchKey(wallet), v: watchDoc.v, json: JSON.stringify(result.profile) }];
      if (earning && !wallets.includes(wallet)) docs.push({ key: ipKey, v: ipDoc.v, json: JSON.stringify([...wallets, wallet]), ttlMs: DAY_MS });
      if (streamer) {
        const last = parsePresence(presenceDoc.json);
        const since = last?.since !== undefined && t - last.at <= STREAM_GAP_MS ? last.since : t;
        docs.push({ key: presenceKey(mint), v: presenceDoc.v, json: JSON.stringify({ at: t, since } satisfies Presence), ttlMs: 2 * STREAM_GAP_MS });
      }
      const moves = result.points > 0 ? [{ wallet, delta: result.points, floor: 0 }] : [];
      const status = await store.commit({ docs, moves, won: [] });
      if (status === "ok") return { accepted: true, points: result.points };
      await pause();
    }
    throw new ContentionError("Busy, try again");
  }

  /** A signed-in wallet's action on a coin's game. */
  async function act(mint: string, wallet: string, action: Action): Promise<PredictionsView> {
    const { creator } = await facts(mint);
    // Holding the coin is checked only where it matters (one cached read), not on every bet.
    const holder = action.kind === "suggest" || action.kind === "upvote" ? await deps.holds(mint, wallet) : false;
    for (let i = 0; i < attempts; i++) {
      const [coinDoc, watchDoc, presenceDoc] = await store.read([coinKey(mint), watchKey(wallet), presenceKey(mint)]);
      const [balance] = await store.balances([wallet]);
      const game = parseGame(coinDoc.json, creator);
      const eligible = isEligible(parseProfile(watchDoc.json));
      const result = apply(game, action, { wallet, eligible, holder, balance }, now(), parseEnv(presenceDoc.json));
      const status = await store.commit({ docs: [{ key: coinKey(mint), v: coinDoc.v, json: JSON.stringify(result.game) }], ...movesOf(result) });
      if (status === "ok") return view(mint, wallet);
      if (status === "insufficient") throw new GameError(action.kind === "bet" ? "You can bet at most half your points" : "Not enough points");
      await pause();
    }
    throw new ContentionError("Busy, try again");
  }

  /** Runs the clock (expiry, auto-cancel, results counting, auto-launch), saving it if anything was due. */
  async function ticked(mint: string, creator: string): Promise<{ game: Game; env: Env }> {
    for (let i = 0; i < 3; i++) {
      const [doc, presenceDoc] = await store.read([coinKey(mint), presenceKey(mint)]);
      const env = parseEnv(presenceDoc.json);
      const game = parseGame(doc.json, creator);
      const result = apply(game, { kind: "tick" }, null, now(), env);
      if (!result.changed) return { game, env };
      const status = await store.commit({ docs: [{ key: coinKey(mint), v: doc.v, json: JSON.stringify(result.game) }], ...movesOf(result) });
      if (status === "ok") return { game: result.game, env };
    }
    // Others are saving the same tick; show what's stored.
    const [doc, presenceDoc] = await store.read([coinKey(mint), presenceKey(mint)]);
    return { game: parseGame(doc.json, creator), env: parseEnv(presenceDoc.json) };
  }

  /** Only wallets with 30+ minutes watched appear on leaderboards. */
  async function eligibleLeaders(candidates: LeaderRow[]): Promise<LeaderRow[]> {
    if (candidates.length === 0) return [];
    const docs = await store.read(candidates.map((c) => watchKey(c.wallet)));
    return candidates.filter((_, i) => onLeaderboard(docs[i].json ? (JSON.parse(docs[i].json!) as Profile) : null));
  }

  /** Leaderboards change only when results count, so each is cached briefly (fewer reads per poll). */
  const boards = new Map<string, { at: number; key: string; rows: LeaderRow[] }>();
  async function cachedBoard(id: string, key: string, load: () => Promise<LeaderRow[]>) {
    const hit = boards.get(id);
    if (hit && hit.key === key && now() - hit.at < LEADERBOARD_CACHE_MS) return hit.rows;
    const rows = await load();
    boards.set(id, { at: now(), key, rows });
    if (boards.size > 1_000) boards.delete(boards.keys().next().value!);
    return rows;
  }

  const standing = (board: LeaderRow[], wallet: string, fallback: number | undefined): Standing | null => {
    const at = board.findIndex((l) => l.wallet === wallet);
    if (at >= 0) return { points: board[at].points, rank: at + 1 };
    return fallback === undefined ? null : { points: fallback, rank: null };
  };

  /**
   * The signed-out view is the same for everyone, so it is reused for a moment per coin (fewer
   * reads per poll). Signed-in views carry the wallet's own fields and are never cached.
   */
  const publicViews = new Map<string, { at: number; view: PredictionsView }>();
  async function view(mint: string, wallet: string | null): Promise<PredictionsView> {
    if (wallet) return build(mint, wallet);
    const hit = publicViews.get(mint);
    if (hit && now() - hit.at < PUBLIC_VIEW_CACHE_MS) return { ...hit.view, now: now() };
    const fresh = await build(mint, null);
    publicViews.set(mint, { at: now(), view: fresh });
    if (publicViews.size > 1_000) publicViews.delete(publicViews.keys().next().value!);
    return fresh;
  }

  async function build(mint: string, wallet: string | null): Promise<PredictionsView> {
    const { creator } = await facts(mint);
    const { game, env } = await ticked(mint, creator);
    const t = now();

    const wonKey = JSON.stringify(game.won);
    const [streamBoard, allTimeBoard] = await Promise.all([
      cachedBoard(`stream:${mint}`, wonKey, () =>
        eligibleLeaders(
          Object.entries(game.won)
            .map(([w, points]) => ({ wallet: w, points }))
            .sort(byPoints)
            .slice(0, LEADER_CANDIDATES),
        ),
      ),
      cachedBoard("all", "", () => store.topWon(LEADER_CANDIDATES).then(eligibleLeaders)),
    ]);

    let me: PredictionsView["me"] = null;
    if (wallet) {
      const [[balance], [watchDoc]] = await Promise.all([store.balances([wallet]), store.read([watchKey(wallet)])]);
      const profile = parseProfile(watchDoc.json);
      const isStaffWallet = wallet === game.creator || game.mods.includes(wallet);
      // The cached (60 s), budgeted holder check; if the budget says no, it's just unknown.
      const holder = isStaffWallet ? null : await deps.holds(mint, wallet).catch(() => null);
      me = {
        wallet,
        balance,
        watchMinutes: Math.floor(profile.watchMs / 60_000),
        eligible: isEligible(profile),
        starterInMinutes: profile.starter ? null : Math.max(0, Math.ceil((STARTER_AFTER_MS - profile.watchMs) / 60_000)),
        role: wallet === game.creator ? "streamer" : game.mods.includes(wallet) ? "mod" : null,
        hasSuggestion: game.suggestions.some((s) => s.asker === wallet),
        holder,
      };
    }
    const staff = me?.role != null;

    const roleOf = (by: string | null): PredictionsView["resolved"][number]["resolvedBy"] =>
      by === "auto" || by === null ? { role: "auto", wallet: null } : { role: by === game.creator ? "streamer" : "mod", wallet: by };
    const myResult = (p: Summary) => {
      if (!wallet || !p.open || !Object.hasOwn(p.open.results, wallet)) return null;
      const [bet, payout, flagged] = p.open.results[wallet];
      return { bet, payout, flagged: flagged === 1, canFlag: true };
    };
    const live = game.live;

    return {
      now: t,
      launched: game.launched,
      maxPerStream: MAX_PREDICTIONS_PER_STREAM,
      crowdPicks: game.crowdPicks,
      streamerHere: env.streamerSeenAt !== null && t - env.streamerSeenAt < STREAMER_PRESENT_MS,
      me,
      live: live && {
        id: live.id,
        text: live.text,
        launchedAt: live.launchedAt,
        lockAt: live.lockAt,
        autoCancelAt: live.lockAt + (live.launchedBy === "crowd" ? AUTO_CANCEL_CROWD_MS : AUTO_CANCEL_MS),
        yes: live.yes,
        no: live.no,
        bettors: live.bettors,
        myBet: wallet && live.bets[wallet] ? { side: live.bets[wallet].side, amount: live.bets[wallet].amount } : null,
      },
      queueSize: game.suggestions.length,
      queue: [...game.suggestions]
        .sort((a, b) => b.upvotes - a.upvotes || a.at - b.at)
        .slice(0, QUEUE_SHOWN)
        .map((s) => ({
          id: s.id,
          text: s.text,
          upvotes: s.upvotes,
          expiresAt: s.at + SUGGEST_TTL_MS,
          mine: s.asker === wallet,
          upvoted: wallet !== null && (s.upvoters.includes(wallet) || s.extra.includes(wallet.slice(0, 10))),
        })),
      resolved: game.resolved.slice(0, RESOLVED_SHOWN).map((p) => ({
        id: p.id,
        text: p.text,
        outcome: p.outcome,
        resolvedAt: p.resolvedAt,
        resolvedBy: roleOf(p.resolvedBy),
        disputed: p.disputed,
        flagUntil: p.open ? p.resolvedAt + FLAG_WINDOW_MS : null,
        my: myResult(p),
      })),
      mods: staff ? game.mods : [],
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

  /** The signed-in wallet behind a session token, or null. */
  const walletOf = (token: string | null) => walletFromToken(token, now(), deps.secret);

  return { session, beat, act, view, walletOf };
}

export type PredictionsService = ReturnType<typeof predictionsService>;
