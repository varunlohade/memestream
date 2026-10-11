/**
 * Predictions service: ties identity (session tokens), the pure game engine and the atomic store
 * together. Every write reads the documents it needs, runs the engine, and commits the result in
 * one atomic step; if another request committed first ("conflict"), it re-reads and tries again.
 * Dependencies are passed in, so tests run it against the in-memory store with a fake clock.
 */
import { createHmac } from "node:crypto";
import { isIPv6 } from "node:net";
import { type Action, apply, AUTO, autoCancelAt, type Env, type Game, GameError, hasUpvoted, isStaff, newGame, rankWon, streamerPresent, type Summary } from "@/lib/predictions/engine";
import { MESSAGE_TTL_MS } from "@/lib/predictions/message";
import { FLAG_WINDOW_MS, MAX_EARNING_WALLETS_PER_IP, MAX_PREDICTIONS_PER_STREAM, MINUTE_MS, STARTER_AFTER_MS, STREAM_GAP_MS, SUGGEST_TTL_MS } from "@/lib/predictions/rules";
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
  /** Whether `wallet` holds at least 1 whole coin (cached, budgeted read). */
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
const DEFAULT_COMMIT_ATTEMPTS = 12;
/** A tick that keeps losing the race just shows what others saved. */
const TICK_COMMIT_ATTEMPTS = 3;
const BACKOFF_MIN_MS = 5;
const BACKOFF_JITTER_MS = 40;
const LEADER_CANDIDATES = 50;
const LEADERBOARD_CACHE_MS = 15_000;
const PUBLIC_VIEW_CACHE_MS = 1_500;
/** Entries kept per in-process cache; the oldest goes first. */
const MAX_CACHE_ENTRIES = 1_000;
/** The GET response lists at most this many waiting suggestions, recent results and top leaders. */
const QUEUE_SHOWN = 20;
const RESOLVED_SHOWN = 5;
const LEADERS_SHOWN = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Characters of the keyed IP hash kept in its key (132 bits). */
const IP_HASH_CHARS = 22;
const IPV6_GROUPS = 8;
const IPV6_PREFIX_GROUPS = 4;

/**
 * The part of an IP that names one client for the per-IP cap: an IPv4 address whole, an IPv6
 * address by its /64 prefix (one home or phone usually gets a whole /64 to pick from).
 */
export function ipBucket(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1];
  if (!isIPv6(addr)) return addr;
  const groups = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const [head, tail] = addr.split("::");
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const full = [...left, ...Array<string>(IPV6_GROUPS - left.length - right.length).fill("0"), ...right];
  return `${full.slice(0, IPV6_PREFIX_GROUPS).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/** The per-IP, per-UTC-day key. The IP is never stored, only a keyed hash of it. */
function ipDayKey(secret: string, ip: string, now: number) {
  const hash = createHmac("sha256", secret).update(`ip:${ipBucket(ip)}`).digest("base64url").slice(0, IP_HASH_CHARS);
  return `ip:${hash}:${utcDay(now)}`;
}

/** The streamer's presence after a beat at `now`: the same stream unless they were away 2+ hours. */
function nextPresence(last: Presence | null, now: number): Presence {
  const since = last?.since !== undefined && now - last.at <= STREAM_GAP_MS ? last.since : now;
  return { at: now, since };
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

/** The engine's point movements, in the store's commit shape. */
const ledgerChanges = (result: ReturnType<typeof apply>) => ({
  moves: [...result.moves].map(([w, m]) => ({ wallet: w, delta: m.delta, floor: m.floor })),
  won: [...result.won].map(([w, delta]) => ({ wallet: w, delta })),
});

function remember<V>(cache: Map<string, V>, key: string, value: V) {
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

const standing = (board: LeaderRow[], wallet: string, fallback: number | undefined): Standing | null => {
  const at = board.findIndex((l) => l.wallet === wallet);
  if (at >= 0) return { points: board[at].points, rank: at + 1 };
  return fallback === undefined ? null : { points: fallback, rank: null };
};

/** The top line shows winners only; a wallet's own standing can be below zero. */
const topWinners = (board: LeaderRow[]) => board.filter((l) => l.points > 0).slice(0, LEADERS_SHOWN);

function liveView(game: Game, wallet: string | null): PredictionsView["live"] {
  const live = game.live;
  if (!live) return live;
  const myBet = wallet ? live.bets[wallet] : undefined;
  return {
    id: live.id,
    text: live.text,
    launchedAt: live.launchedAt,
    lockAt: live.lockAt,
    autoCancelAt: autoCancelAt(live),
    yes: live.yes,
    no: live.no,
    bettors: live.bettors,
    myBet: myBet ? { side: myBet.side, amount: myBet.amount } : null,
  };
}

function queueView(game: Game, wallet: string | null): PredictionsView["queue"] {
  return [...game.suggestions]
    .sort((a, b) => b.upvotes - a.upvotes || a.at - b.at)
    .slice(0, QUEUE_SHOWN)
    .map((s) => ({
      id: s.id,
      text: s.text,
      upvotes: s.upvotes,
      expiresAt: s.at + SUGGEST_TTL_MS,
      mine: s.asker === wallet,
      upvoted: wallet !== null && hasUpvoted(s, wallet),
    }));
}

type ResolvedView = PredictionsView["resolved"][number];

const resolverOf = (game: Game, by: string | null): ResolvedView["resolvedBy"] =>
  by === AUTO || by === null ? { role: "auto", wallet: null } : { role: by === game.creator ? "streamer" : "mod", wallet: by };

function myResult(p: Summary, wallet: string | null): ResolvedView["my"] {
  if (!wallet || !p.open || !Object.hasOwn(p.open.results, wallet)) return null;
  const [bet, payout, flagged] = p.open.results[wallet];
  return { bet, payout, flagged: flagged === 1, canFlag: true };
}

function resolvedView(game: Game, wallet: string | null): PredictionsView["resolved"] {
  return game.resolved.slice(0, RESOLVED_SHOWN).map((p) => ({
    id: p.id,
    text: p.text,
    outcome: p.outcome,
    resolvedAt: p.resolvedAt,
    resolvedBy: resolverOf(game, p.resolvedBy),
    disputed: p.disputed,
    flagUntil: p.open ? p.resolvedAt + FLAG_WINDOW_MS : null,
    my: myResult(p, wallet),
  }));
}

/** Returned by a commit attempt that lost the race; the caller pauses and tries again. */
const RETRY = Symbol("retry");

export function predictionsService(deps: ServiceDeps) {
  const { store, now } = deps;
  const attempts = deps.attempts ?? DEFAULT_COMMIT_ATTEMPTS;
  const pause = () => new Promise((resolve) => setTimeout(resolve, deps.backoffMs?.() ?? BACKOFF_MIN_MS + Math.random() * BACKOFF_JITTER_MS));

  /** Runs `attempt` until it commits, up to `attempts` times; then the coin is too busy. */
  async function retryOnConflict<T>(attempt: () => Promise<T | typeof RETRY>): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      const result = await attempt();
      if (result !== RETRY) return result;
      await pause();
    }
    throw new ContentionError("Busy, try again");
  }

  async function facts(mint: string) {
    const coin = await deps.coin(mint);
    if (!coin) throw new UnknownCoinError("Coin not found");
    return coin;
  }

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
    const ipKey = ipDayKey(deps.secret, ip, t);
    const streamer = wallet === coin.creator;
    return retryOnConflict(async () => {
      const [watchDoc, ipDoc, presenceDoc] = await store.read([watchKey(wallet), ipKey, presenceKey(mint)]);
      const wallets: string[] = ipDoc.json ? JSON.parse(ipDoc.json) : [];
      const earning = wallets.includes(wallet) || wallets.length < MAX_EARNING_WALLETS_PER_IP;
      const result = heartbeat(parseProfile(watchDoc.json), t, earning);
      if (!result.accepted) return { accepted: false, points: 0 };
      const docs: Commit["docs"] = [{ key: watchKey(wallet), v: watchDoc.v, json: JSON.stringify(result.profile) }];
      if (earning && !wallets.includes(wallet)) docs.push({ key: ipKey, v: ipDoc.v, json: JSON.stringify([...wallets, wallet]), ttlMs: DAY_MS });
      if (streamer) {
        const presence = nextPresence(parsePresence(presenceDoc.json), t);
        docs.push({ key: presenceKey(mint), v: presenceDoc.v, json: JSON.stringify(presence), ttlMs: 2 * STREAM_GAP_MS });
      }
      const moves = result.points > 0 ? [{ wallet, delta: result.points, floor: 0 }] : [];
      const status = await store.commit({ docs, moves, won: [] });
      return status === "ok" ? { accepted: true, points: result.points } : RETRY;
    });
  }

  /** A signed-in wallet's action on a coin's game. */
  async function act(mint: string, wallet: string, action: Action): Promise<PredictionsView> {
    const { creator } = await facts(mint);
    // Holding the coin is checked only where it matters (one cached read), not on every bet.
    const holder = action.kind === "suggest" || action.kind === "upvote" ? await deps.holds(mint, wallet) : false;
    return retryOnConflict(async () => {
      const [coinDoc, watchDoc, presenceDoc] = await store.read([coinKey(mint), watchKey(wallet), presenceKey(mint)]);
      const [balance] = await store.balances([wallet]);
      const game = parseGame(coinDoc.json, creator);
      const eligible = isEligible(parseProfile(watchDoc.json));
      const result = apply(game, action, { wallet, eligible, holder, balance }, now(), parseEnv(presenceDoc.json));
      const status = await store.commit({ docs: [{ key: coinKey(mint), v: coinDoc.v, json: JSON.stringify(result.game) }], ...ledgerChanges(result) });
      if (status === "ok") return view(mint, wallet);
      if (status === "insufficient") throw new GameError(action.kind === "bet" ? "You can bet at most half your points" : "Not enough points");
      return RETRY;
    });
  }

  /** Runs the clock (expiry, auto-cancel, results counting, auto-launch), saving it if anything was due. */
  async function ticked(mint: string, creator: string): Promise<{ game: Game; env: Env }> {
    for (let i = 0; i < TICK_COMMIT_ATTEMPTS; i++) {
      const [doc, presenceDoc] = await store.read([coinKey(mint), presenceKey(mint)]);
      const env = parseEnv(presenceDoc.json);
      const game = parseGame(doc.json, creator);
      const result = apply(game, { kind: "tick" }, null, now(), env);
      if (!result.changed) return { game, env };
      const status = await store.commit({ docs: [{ key: coinKey(mint), v: doc.v, json: JSON.stringify(result.game) }], ...ledgerChanges(result) });
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
    return candidates.filter((_, i) => onLeaderboard(parseProfile(docs[i].json)));
  }

  /** Leaderboards change only when results count, so each is cached briefly (fewer reads per poll). */
  const boards = new Map<string, { at: number; key: string; rows: LeaderRow[] }>();
  async function cachedBoard(id: string, key: string, load: () => Promise<LeaderRow[]>) {
    const hit = boards.get(id);
    if (hit && hit.key === key && now() - hit.at < LEADERBOARD_CACHE_MS) return hit.rows;
    const rows = await load();
    remember(boards, id, { at: now(), key, rows });
    return rows;
  }

  /** The stream board (cached until the coin's winnings change) and the all-time board. */
  function leaderboards(mint: string, game: Game) {
    return Promise.all([
      cachedBoard(`stream:${mint}`, JSON.stringify(game.won), () => eligibleLeaders(rankWon(game.won).slice(0, LEADER_CANDIDATES))),
      cachedBoard("all", "", () => store.topWon(LEADER_CANDIDATES).then(eligibleLeaders)),
    ]);
  }

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
    remember(publicViews, mint, { at: now(), view: fresh });
    return fresh;
  }

  /** The signed-in wallet's own fields: points, watch time, role and whether it holds the coin. */
  async function viewer(mint: string, wallet: string, game: Game): Promise<NonNullable<PredictionsView["me"]>> {
    const [[balance], [watchDoc]] = await Promise.all([store.balances([wallet]), store.read([watchKey(wallet)])]);
    const profile = parseProfile(watchDoc.json);
    // The cached (60 s), budgeted holder check; if the budget says no, it's just unknown.
    const holder = isStaff(game, wallet) ? null : await deps.holds(mint, wallet).catch(() => null);
    return {
      wallet,
      balance,
      watchMinutes: Math.floor(profile.watchMs / MINUTE_MS),
      eligible: isEligible(profile),
      starterInMinutes: profile.starter ? null : Math.max(0, Math.ceil((STARTER_AFTER_MS - profile.watchMs) / MINUTE_MS)),
      role: wallet === game.creator ? "streamer" : game.mods.includes(wallet) ? "mod" : null,
      hasSuggestion: game.suggestions.some((s) => s.asker === wallet),
      holder,
    };
  }

  async function build(mint: string, wallet: string | null): Promise<PredictionsView> {
    const { creator } = await facts(mint);
    const { game, env } = await ticked(mint, creator);
    const t = now();
    const [streamBoard, allTimeBoard] = await leaderboards(mint, game);
    const me = wallet ? await viewer(mint, wallet, game) : null;
    const staff = me?.role != null;

    return {
      now: t,
      launched: game.launched,
      maxPerStream: MAX_PREDICTIONS_PER_STREAM,
      crowdPicks: game.crowdPicks,
      streamerHere: streamerPresent(env, t),
      me,
      live: liveView(game, wallet),
      queueSize: game.suggestions.length,
      queue: queueView(game, wallet),
      resolved: resolvedView(game, wallet),
      mods: staff ? game.mods : [],
      leaderboard: {
        stream: topWinners(streamBoard),
        allTime: topWinners(allTimeBoard),
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
