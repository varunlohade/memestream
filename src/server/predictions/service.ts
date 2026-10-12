/**
 * Predictions service: ties identity (session tokens), the pure game engine and the atomic store
 * together. Every write reads the documents it needs, runs the engine, and commits the result in
 * one atomic step; if another request committed first ("conflict"), it re-reads and tries again.
 * Dependencies are passed in, so tests run it against the in-memory store with a fake clock.
 */
import { createHmac, randomUUID } from "node:crypto";
import { isIPv6 } from "node:net";
import { type Action, apply, AUTO, autoCancelAt, type Env, type Game, GameError, hasUpvoted, isStaff, rankWon, streamerPresent, type Summary } from "@/lib/predictions/engine";
import { applyReview, type ReviewTarget, type ReviewVerdict, reviewsDue, reviewStuck, STAFF, startReviews } from "@/lib/predictions/engine";
import { aiDue, type AiVerdict, applyAiVerdict, applyFrame, type CaptureTarget, type CheckTarget, type FrameNote, startAi } from "@/lib/predictions/engine";
import { applyMarketDone, applyMarketTryFailed, applyMarketUnavailable, hasPendingMarkets, challengeEndsAt, marketFinal, type MarketJob, type MarketState, needsAdmin, proposedOutcome, type MarketOutcome, marketsDue, startMarkets } from "@/lib/predictions/engine";
import type { MarketRecord } from "@/lib/markets/record";
import { MESSAGE_TTL_MS } from "@/lib/predictions/message";
import { AI_CHECK_MAX_TRIES, FLAG_WINDOW_MS, MAX_GRANTS_PER_IP, MAX_PREDICTIONS_PER_STREAM, MIN_HEARTBEAT_GAP_MS, STREAM_GAP_MS, SUGGEST_TTL_MS } from "@/lib/predictions/rules";
import type { LeaderRow, MarketStepView, PredictionsView, Standing } from "@/lib/predictions/view";
import { grant, isEligible, newProfile, onLeaderboard, type Profile, utcDay } from "@/lib/predictions/watch";
import { frameUrls } from "./frames";
import { GAME_KEY_COUNT, gameKeys, loadGame } from "./game-doc";
import { issueToken, verifySessionMessage, walletFromToken } from "./identity";
import type { Commit, PredictionStore } from "./store";

export type CoinFacts = { creator: string; status: "trading" | "graduating" | "graduated"; streamUrl?: string | null; symbol?: string };

/** Thrown by MarketDeps.create when the market can never be made (its pool address is taken): no retries. */
export class MarketUnavailable extends Error {}

/**
 * The oracle's market steps (MEMESTREAM_MARKETS). Each is idempotent on chain and throws if it
 * didn't finish; create returns the market's addresses for the registry.
 */
export type MarketDeps = {
  create: (mint: string, predictionId: string, symbol: string) => Promise<Omit<MarketRecord, "lockAt" | "source">>;
  close: (record: MarketRecord) => Promise<unknown>;
  resolve: (record: MarketRecord, outcome: MarketOutcome) => Promise<unknown>;
  /** Whether `wallet` holds any YES or NO of the market (one budgeted read). */
  holdsShares: (record: MarketRecord, wallet: string) => Promise<boolean>;
  /** The oracle redeems the YES/NO its liquidity came back as (nothing held: nothing sent). */
  redeemOracle: (record: MarketRecord) => Promise<unknown>;
};

/** The AI check's two steps; each throws if its model fails (timeout, error, malformed answer). */
export type AiCheckDeps = {
  /** Grabs the stream's frame now and describes what it shows about the question; null if the stream has no frame. */
  describe: (question: string, streamUrl: string) => Promise<string | null>;
  /** What happened, from the question and the frame notes only (never the streamer's outcome). */
  decide: (question: string, notes: FrameNote[]) => Promise<"yes" | "no" | "unclear">;
};

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
  /** The AI review of a typed question; throws if it fails (timeout, error, no key, malformed answer). */
  review: (question: string) => Promise<ReviewVerdict>;
  /** The AI check of results; null or absent when it isn't set up (no keys). */
  ai?: AiCheckDeps | null;
  /** On-chain markets; null or absent when MEMESTREAM_MARKETS is off (then nothing changes). */
  markets?: MarketDeps | null;
  /** Wallets that settle market challenges (MEMESTREAM_ADMIN_WALLETS). */
  admins?: string[];
  /** The market challenge window (shorter only in test runs). */
  challengeMs?: number;
  /** Runs a task after the response is sent (Next's `after`). */
  defer: (task: () => Promise<void>) => void;
  /** Commit attempts before answering "busy", and the pause between them. */
  attempts?: number;
  backoffMs?: () => number;
  /**
   * A market whose betting closes within this long gets a timer (inside the response's after-work)
   * that closes it right at lockAt, instead of waiting for the next view. 0 turns the timer off (tests).
   */
  closeWaitMs?: number;
};

/** Too many concurrent writers on one coin: the caller should answer "busy, try again". */
export class ContentionError extends Error {}
/** Not a memestream coin. */
export class UnknownCoinError extends Error {}

const watchKey = (wallet: string) => `watch:${wallet}`;
const presenceKey = (mint: string) => `presence:${mint}`;
/** A market the oracle created: the registry trades, odds and redeems are limited to. */
const marketKey = (mint: string, predictionId: string) => `market:${mint}:${predictionId}`;
/** Coins with a market that still needs a server step: the close-due sweep's list (a few dozen at most). */
const OPEN_MARKETS_KEY = "markets:open";
/** The streamer's last heartbeat on their coin, and when this stream started (after 2+ hours away). */
type Presence = { at: number; since?: number };
const DEFAULT_COMMIT_ATTEMPTS = 12;
/** Close timers cover locks this close (they run inside the response's after-work, which has a time limit). */
const DEFAULT_CLOSE_WAIT_MS = 60_000;
/** A timer fires this long after lockAt, so the server clock is surely past it. */
const CLOSE_TIMER_SLACK_MS = 500;
/** How long an action's idempotency id is remembered: far longer than one request and its re-sends. */
const ACT_ONCE_TTL_MS = 10 * 60 * 1000;
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

const parseProfile = (json: string | null): Profile => (json ? { ...newProfile(), ...JSON.parse(json) } : newProfile());
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
  return game.live.map((live) => {
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
      market: marketStepView(live.market),
      source: live.source ?? null,
    };
  });
}

/** Waiting suggestions this viewer can see: approved ones, their own under review, and stuck ones for staff. */
const visibleSuggestions = (game: Game, wallet: string | null, staff: boolean) =>
  game.suggestions.filter((s) => !s.review || s.asker === wallet || (staff && reviewStuck(s.review)));

function queueView(game: Game, wallet: string | null, staff: boolean): PredictionsView["queue"] {
  return visibleSuggestions(game, wallet, staff)
    .sort((a, b) => b.upvotes - a.upvotes || a.at - b.at)
    .slice(0, QUEUE_SHOWN)
    .map((s) => ({
      id: s.id,
      text: s.text,
      upvotes: s.upvotes,
      expiresAt: s.at + SUGGEST_TTL_MS,
      mine: s.asker === wallet,
      upvoted: wallet !== null && hasUpvoted(s, wallet),
      status: s.review ? "review" : "ok",
      stuck: s.review ? reviewStuck(s.review) : false,
    }));
}

const pendingView = (game: Game): PredictionsView["pending"] =>
  game.pending ? { id: game.pending.id, text: game.pending.text, stuck: reviewStuck(game.pending.review) } : null;

/** The wallet's own "Not approved" note; staff also see notes about typed staff questions. */
const noticeFor = (game: Game, wallet: string, staff: boolean) =>
  [...game.notices].reverse().find((n) => n.to === wallet || (staff && n.to === STAFF))?.text ?? null;

type ResolvedView = PredictionsView["resolved"][number];

/** Who resolved it. Only the streamer and mods see the wallet; everyone else sees the role. */
const resolverOf = (game: Game, by: string | null, staff: boolean): ResolvedView["resolvedBy"] =>
  by === AUTO || by === null ? { role: "auto", wallet: null } : { role: by === game.creator ? "streamer" : "mod", wallet: staff ? by : null };

function myResult(p: Summary, wallet: string | null, now: number): ResolvedView["my"] {
  if (!wallet || !p.open || !Object.hasOwn(p.open.results, wallet)) return null;
  const [bet, payout, flagged] = p.open.results[wallet];
  // A result held open past its window for its AI check takes no flags.
  return { bet, payout, flagged: flagged === 1, canFlag: now < p.resolvedAt + FLAG_WINDOW_MS };
}

/** A market's place in its challenge window; why it waits and the challenge itself only for admins. */
function verdictView(p: Summary, now: number, env: Env, admin: boolean): PredictionsView["resolved"][number]["verdict"] {
  const m = p.market;
  if (!m || m.step === "opening" || m.step === "failed") return null;
  const final = marketFinal(p, now, env);
  const c = m.challenge;
  const waits = needsAdmin(p);
  const disputed = !m.decision && (c !== undefined || waits !== null);
  return {
    status: final ? "final" : disputed ? "disputed" : "proposed",
    proposed: proposedOutcome(p),
    finalAt: disputed || final ? null : challengeEndsAt(p, env),
    final,
    why: admin && disputed ? (c ? "challenge" : (waits?.why ?? null)) : null,
    challenge: admin && c ? { by: c.by, at: c.at, reason: c.reason, link: c.link ?? null, bond: c.bond } : null,
  };
}

/** The market's step as the view shows it: "closed" once trading closed and before it resolves. */
const marketStepView = (m: MarketState | undefined): MarketStepView => (!m ? null : m.step === "open" && m.closed ? "closed" : m.step);

function resolvedView(game: Game, wallet: string | null, staff: boolean, now: number, env: Env, admin: boolean): PredictionsView["resolved"] {
  return game.resolved.slice(0, RESOLVED_SHOWN).map((p) => ({
    id: p.id,
    text: p.text,
    outcome: p.outcome,
    resolvedAt: p.resolvedAt,
    resolvedBy: resolverOf(game, p.resolvedBy, staff),
    disputed: p.disputed,
    ai: p.check ? "checking" : (p.ai?.verdict ?? null),
    flagUntil: p.open ? p.resolvedAt + FLAG_WINDOW_MS : null,
    my: myResult(p, wallet, now),
    market: marketStepView(p.market),
    source: p.source ?? null,
    launchedAt: p.window?.[0] ?? null,
    lockAt: p.window?.[1] ?? null,
    verdict: verdictView(p, now, env, admin),
  }));
}

/** Returned by a commit attempt that lost the race; the caller pauses and tries again. */
const RETRY = Symbol("retry");

export function predictionsService(deps: ServiceDeps) {
  const { store, now } = deps;
  const attempts = deps.attempts ?? DEFAULT_COMMIT_ATTEMPTS;
  /** The coin's environment for the engine; markets follow the server flag. */
  const envOf = (presenceJson: string | null, extra: Partial<Env> = {}): Env => ({
    ...parseEnv(presenceJson),
    markets: Boolean(deps.markets),
    admins: deps.admins ?? [],
    ...(deps.challengeMs !== undefined ? { challengeMs: deps.challengeMs } : {}),
    ...extra,
  });
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

  /** The coin's game (its document and every live slot) and the `extra` documents, in one read. */
  async function readGame(mint: string, creator: string, extra: string[]) {
    const docs = await store.read([...gameKeys(mint), ...extra]);
    return { ...loadGame(mint, docs.slice(0, GAME_KEY_COUNT), creator), extra: docs.slice(GAME_KEY_COUNT) };
  }

  async function facts(mint: string) {
    const coin = await deps.coin(mint);
    if (!coin) throw new UnknownCoinError("Coin not found");
    return coin;
  }

  /**
   * Signs a wallet in: checks its signed message (domain, expiry, signature), uses the nonce once,
   * returns a session token. A wallet's first sign-in also gets the one-time grant, in the same
   * commit, if its IP hasn't had MAX_GRANTS_PER_IP wallets granted today (else a later sign-in can).
   */
  async function session(message: string, signature: string, ip: string) {
    const t = now();
    const verified = verifySessionMessage(message, signature, t, deps.domain);
    if (!verified.ok) throw new GameError(verified.error);
    const { wallet, nonce } = verified.request;
    const ipKey = ipDayKey(deps.secret, ip, t);
    const granted = await retryOnConflict(async () => {
      const [watchDoc, ipDoc] = await store.read([watchKey(wallet), ipKey]);
      const wallets: string[] = ipDoc.json ? JSON.parse(ipDoc.json) : [];
      const result = grant(parseProfile(watchDoc.json), wallets.includes(wallet) || wallets.length < MAX_GRANTS_PER_IP);
      const docs: Commit["docs"] = [];
      if (result.points > 0) {
        docs.push({ key: watchKey(wallet), v: watchDoc.v, json: JSON.stringify(result.profile) });
        if (!wallets.includes(wallet)) docs.push({ key: ipKey, v: ipDoc.v, json: JSON.stringify([...wallets, wallet]), ttlMs: DAY_MS });
      }
      const moves = result.points > 0 ? [{ wallet, delta: result.points, floor: 0 }] : [];
      const status = await store.commit({ docs, moves, won: [], nonce: { key: `nonce:${wallet}:${nonce}`, ttlMs: MESSAGE_TTL_MS * 2 } });
      if (status === "replay") throw new GameError("That signature was already used. Sign in again.");
      return status === "ok" ? result.points : RETRY;
    });
    return { wallet, ...issueToken(wallet, t, deps.secret), granted };
  }

  /**
   * The streamer's page beats once a minute while open: that marks them "here" (the crowd's
   * questions go live only then) and starts a new stream after 2+ hours away. Anyone else's beat,
   * or one too soon after the last, does nothing. Viewers earn nothing from watching.
   */
  async function beat(wallet: string, mint: string) {
    const coin = await facts(mint);
    if (wallet !== coin.creator || coin.status === "graduating") return { accepted: false };
    const t = now();
    return retryOnConflict(async () => {
      const [presenceDoc] = await store.read([presenceKey(mint)]);
      const last = parsePresence(presenceDoc.json);
      if (last && t - last.at < MIN_HEARTBEAT_GAP_MS) return { accepted: false };
      const docs: Commit["docs"] = [{ key: presenceKey(mint), v: presenceDoc.v, json: JSON.stringify(nextPresence(last, t)), ttlMs: 2 * STREAM_GAP_MS }];
      const status = await store.commit({ docs, moves: [], won: [] });
      return status === "ok" ? { accepted: true } : RETRY;
    });
  }

  /**
   * A signed-in wallet's action on a coin's game. Returns the updated view, or null if the action
   * was saved but the view could not be read just then (the next poll shows it).
   */
  async function act(mint: string, wallet: string, action: Action): Promise<PredictionsView | null> {
    const coin = await facts(mint);
    const { creator } = coin;
    const aiCheck = aiOn(coin);
    // Holding the coin is checked only where it matters (one cached read), not on every bet.
    const holder = action.kind === "suggest" || action.kind === "upvote" ? await deps.holds(mint, wallet) : false;
    // A challenge needs shares of that market: one read of the wallet's YES/NO, only for challenges.
    let shares = false;
    if (action.kind === "challenge" && deps.markets) {
      const record = await market(mint, action.id);
      shares = record ? await deps.markets.holdsShares(record, wallet) : false;
    }
    // One id per request: if a commit lands but its reply is lost and the store client re-sends it,
    // the re-send answers "replay" and the action counts once.
    const once = { key: `act:${randomUUID()}`, ttlMs: ACT_ONCE_TTL_MS };
    await retryOnConflict(async () => {
      const { game, save, extra: [watchDoc, presenceDoc] } = await readGame(mint, creator, [watchKey(wallet), presenceKey(mint)]);
      const [balance] = await store.balances([wallet]);
      const eligible = isEligible(parseProfile(watchDoc.json));
      const result = apply(game, action, { wallet, eligible, holder, balance, shares }, now(), envOf(presenceDoc.json, { aiCheck }));
      const status = await store.commit({ docs: save(result.game), ...ledgerChanges(result), nonce: once });
      if (status === "ok" || status === "replay") return true;
      if (status === "insufficient") throw new GameError(action.kind === "bet" ? "You can bet at most half your points" : "Not enough points");
      return RETRY;
    });
    // A launch needs its first frame and a result its check, even if the view below fails to load.
    if (aiCheck && (action.kind === "launch" || action.kind === "resolve")) startAiRun(mint, coin);
    if (deps.markets) startMarketRun(mint, coin);
    // The action is saved; a failed read now must not turn it into an error the user retries.
    return view(mint, wallet).catch(() => null);
  }

  /** Runs the clock (expiry, auto-cancel, results counting, auto-launch), saving it if anything was due. */
  async function ticked(mint: string, coin: CoinFacts): Promise<{ game: Game; env: Env }> {
    const { creator } = coin;
    for (let i = 0; i < TICK_COMMIT_ATTEMPTS; i++) {
      const { game, save, extra: [presenceDoc] } = await readGame(mint, creator, [presenceKey(mint)]);
      const env = envOf(presenceDoc.json, { aiCheck: aiOn(coin) });
      const result = apply(game, { kind: "tick" }, null, now(), env);
      if (reviewsDue(result.game, now())) startReviewing(mint, creator);
      if (aiDue(result.game, now(), env)) startAiRun(mint, coin);
      if (deps.markets && marketsDue(result.game, now(), env)) startMarketRun(mint, coin);
      if (!result.changed) return { game, env };
      const status = await store.commit({ docs: save(result.game), ...ledgerChanges(result) });
      if (status === "ok") return { game: result.game, env };
    }
    // Others are saving the same tick; show what's stored.
    const { game, extra: [presenceDoc] } = await readGame(mint, creator, [presenceKey(mint)]);
    return { game, env: envOf(presenceDoc.json) };
  }

  /** Coins with a review run in flight in this process (another process is held off by the claim). */
  const reviewing = new Set<string>();

  /** Reviews the coin's due questions after the response is sent; one run per coin at a time. */
  function startReviewing(mint: string, creator: string) {
    if (reviewing.has(mint)) return;
    reviewing.add(mint);
    deps.defer(() =>
      reviewDue(mint, creator)
        .catch(() => console.warn("predictions: a review run failed; the next view retries it"))
        .finally(() => reviewing.delete(mint)),
    );
  }

  /**
   * Claims every due check (counts the try, so no other server starts the same one for 15 s), asks
   * the review, and saves each verdict. A failed check leaves its question under review for the
   * next try; it is never approved by default.
   */
  async function reviewDue(mint: string, creator: string) {
    const { game, save, extra: [presenceDoc] } = await readGame(mint, creator, [presenceKey(mint)]);
    const claim = startReviews(game, now(), envOf(presenceDoc.json));
    if (claim.due.length === 0) return;
    const status = await store.commit({ docs: save(claim.game), ...ledgerChanges(claim) });
    if (status !== "ok") return; // the coin changed meanwhile: the next view claims again
    await Promise.all(claim.due.map((target) => reviewOne(mint, creator, target)));
  }

  async function reviewOne(mint: string, creator: string, target: ReviewTarget) {
    let verdict: ReviewVerdict;
    try {
      verdict = await deps.review(target.text);
    } catch (error) {
      console.warn(`predictions: review check failed (${error instanceof Error ? error.message : "unknown error"}); it stays under review`);
      return;
    }
    await retryOnConflict(async () => {
      const { game, save, extra: [presenceDoc] } = await readGame(mint, creator, [presenceKey(mint)]);
      const result = applyReview(game, target, verdict, now(), envOf(presenceDoc.json));
      if (!result.changed) return true;
      const status = await store.commit({ docs: save(result.game), ...ledgerChanges(result) });
      return status === "ok" ? true : RETRY;
    });
  }

  /** The coin's stream has preview frames and the AI check is set up. */
  const aiOn = (coin: CoinFacts) => Boolean(deps.ai && frameUrls(coin.streamUrl).length > 0);
  /** Coins with an AI run in flight in this process (another process is held off by the claim). */
  const aiRunning = new Set<string>();

  /** Grabs due frames and checks due results after the response is sent; one run per coin at a time. */
  function startAiRun(mint: string, coin: CoinFacts) {
    if (aiRunning.has(mint)) return;
    aiRunning.add(mint);
    deps.defer(() =>
      aiRun(mint, coin)
        .catch(() => console.warn("predictions: an AI check run failed; the next view retries it"))
        .finally(() => aiRunning.delete(mint)),
    );
  }

  /** Commits `step`'s result to the coin's game, re-reading on a conflict; nothing to save is fine. */
  const commitGame = (mint: string, creator: string, step: (game: Game, env: Env) => ReturnType<typeof apply>) =>
    retryOnConflict(async () => {
      const { game, save, extra: [presenceDoc] } = await readGame(mint, creator, [presenceKey(mint)]);
      const result = step(game, envOf(presenceDoc.json));
      if (!result.changed) return true;
      const status = await store.commit({ docs: save(result.game), ...ledgerChanges(result) });
      return status === "ok" ? true : RETRY;
    });

  /** Claims every due frame grab and check run (so no other server starts them), then runs them. */
  async function aiRun(mint: string, coin: CoinFacts) {
    const ai = deps.ai;
    const streamUrl = coin.streamUrl;
    if (!ai || !streamUrl || !aiOn(coin)) return;
    const { game, save, extra: [presenceDoc] } = await readGame(mint, coin.creator, [presenceKey(mint)]);
    const claim = startAi(game, now(), envOf(presenceDoc.json, { aiCheck: true }));
    if (claim.captures.length === 0 && claim.checks.length === 0) return;
    const status = await store.commit({ docs: save(claim.game), ...ledgerChanges(claim) });
    if (status !== "ok") return; // the coin changed meanwhile: the next view claims again
    await Promise.all([
      ...claim.captures.map((target) => captureOne(ai, mint, coin.creator, streamUrl, target)),
      ...claim.checks.map((target) => checkOne(ai, mint, coin.creator, streamUrl, target)),
    ]);
  }

  /** A frame at launch or lock: its description is saved; a failed grab leaves the note empty. */
  async function captureOne(ai: AiCheckDeps, mint: string, creator: string, streamUrl: string, target: CaptureTarget) {
    let text: string | null;
    try {
      text = await ai.describe(target.text, streamUrl);
    } catch (error) {
      console.warn(`predictions: frame description failed (${error instanceof Error ? error.message : "unknown error"})`);
      return;
    }
    if (text) await commitGame(mint, creator, (game, env) => applyFrame(game, target, text, now(), env));
  }

  /**
   * One check run: the frame at resolve, then jev's unbiased answer, compared with the streamer's
   * outcome. No frame at all: no check. A failed run is tried again later; the last failed run
   * ends as "couldn't tell". A failure is never a disagree.
   */
  async function checkOne(ai: AiCheckDeps, mint: string, creator: string, streamUrl: string, target: CheckTarget) {
    let verdict: AiVerdict | null;
    try {
      const atResolve = await ai.describe(target.text, streamUrl);
      const notes = [...target.frames.filter((f) => f.text), ...(atResolve ? [{ kind: "resolve" as const, at: now(), text: atResolve }] : [])];
      if (notes.length === 0) verdict = null;
      else {
        const happened = await ai.decide(target.text, notes);
        verdict = happened === "unclear" ? "unclear" : happened === target.outcome ? "agree" : "disagree";
      }
    } catch (error) {
      console.warn(`predictions: AI check failed (${error instanceof Error ? error.message : "unknown error"})`);
      if (target.tries < AI_CHECK_MAX_TRIES) return;
      verdict = "unclear";
    }
    await commitGame(mint, creator, (game, env) => applyAiVerdict(game, target.id, verdict, now(), env));
  }

  /** Coins with a market run in flight in this process (another process is held off by the claim). */
  const marketRunning = new Set<string>();
  /** Coins with a close timer waiting in this process. */
  const closeTimers = new Set<string>();
  const closeWaitMs = deps.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS;

  /** One market run for the coin, unless one is already going in this process. */
  async function runMarketsOnce(mint: string, coin: CoinFacts) {
    if (marketRunning.has(mint)) return;
    marketRunning.add(mint);
    try {
      await marketRun(mint, coin);
    } catch (error) {
      console.warn(`predictions: a market run failed (${(error as Error).message}); the next view retries it`);
    } finally {
      marketRunning.delete(mint);
    }
  }

  /** Runs due market steps after the response is sent, then waits for a lock that's close and closes it on time. */
  function startMarketRun(mint: string, coin: CoinFacts) {
    if (marketRunning.has(mint)) return;
    deps.defer(async () => {
      await runMarketsOnce(mint, coin);
      await closeOnTime(mint, coin);
    });
  }

  /** Sleeps until the next open market's lockAt (if it's within closeWaitMs), then runs the close. One timer per coin. */
  async function closeOnTime(mint: string, coin: CoinFacts) {
    if (closeWaitMs <= 0 || closeTimers.has(mint)) return;
    const { game } = await readGame(mint, coin.creator, []);
    const t = now();
    const next = Math.min(...game.live.filter((p) => p.market?.step === "open" && p.lockAt > t).map((p) => p.lockAt));
    if (!Number.isFinite(next) || next - t > closeWaitMs) return;
    closeTimers.add(mint);
    try {
      await new Promise((resolve) => setTimeout(resolve, next - t + CLOSE_TIMER_SLACK_MS));
      await runMarketsOnce(mint, coin);
    } finally {
      closeTimers.delete(mint);
    }
  }

  /** The registered market of a coin's prediction, or null (none, or not created yet). */
  async function market(mint: string, predictionId: string): Promise<MarketRecord | null> {
    const [doc] = await store.read([marketKey(mint, predictionId)]);
    return doc.json ? (JSON.parse(doc.json) as MarketRecord) : null;
  }

  /** The coin's streamer or one of its mods: they resolve its predictions, so they may not bet on its markets either. */
  async function staffOf(mint: string, wallet: string): Promise<boolean> {
    const coin = await facts(mint);
    if (wallet === coin.creator) return true;
    const { game } = await readGame(mint, coin.creator, []);
    return isStaff(game, wallet);
  }

  /** Claims every due market step (so no other server starts it), then runs them one by one: they all sign as the oracle. */
  async function marketRun(mint: string, coin: CoinFacts) {
    const markets = deps.markets;
    if (!markets) return;
    const { game, save, extra: [presenceDoc] } = await readGame(mint, coin.creator, [presenceKey(mint)]);
    const claim = startMarkets(game, now(), envOf(presenceDoc.json));
    if (claim.jobs.length === 0) return;
    const status = await store.commit({ docs: save(claim.game), ...ledgerChanges(claim) });
    if (status !== "ok") return; // the coin changed meanwhile: the next view claims again
    const failed = new Set<string>();
    for (const job of claim.jobs) if (!(await marketStep(markets, mint, coin, claim.game, job))) failed.add(job.id);
    // A failed step gives the claim back early, so it's tried again soon (the claim itself outlasts any run).
    for (const id of failed) await commitGame(mint, coin.creator, (g, env) => applyMarketTryFailed(g, id, now(), env));
    // A market both closed and resolved: the oracle takes its seed back (once more is harmless).
    const { game: after } = await readGame(mint, coin.creator, []);
    for (const id of new Set(claim.jobs.filter((j) => j.kind !== "create").map((j) => j.id))) {
      const m = after.resolved.find((p) => p.id === id)?.market;
      if (m?.step !== "resolved" || !m.closed) continue;
      const record = await market(mint, id);
      if (record) await markets.redeemOracle(record).catch((error: Error) => console.warn(`predictions: the oracle's redeem for prediction ${id} failed (${error.message}); scripts/markets-recover.mts can finish it`));
    }
  }

  /** One market step on chain, then its success saved. A failure is logged (false); it's tried again after a short pause. */
  async function marketStep(markets: MarketDeps, mint: string, coin: CoinFacts, game: Game, job: MarketJob): Promise<boolean> {
    try {
      if (job.kind === "create") {
        const live = game.live.find((p) => p.id === job.id);
        if (!live) return true;
        const created = await markets.create(mint, job.id, coin.symbol ?? "");
        const record: MarketRecord = { ...created, lockAt: live.lockAt, source: live.source ?? coin.streamUrl ?? "" };
        await commitMarketDone(mint, coin.creator, job, record);
        return true;
      }
      const record = await market(mint, job.id);
      if (!record) throw new Error("no registry entry");
      if (job.kind === "close") await markets.close(record);
      else await markets.resolve(record, job.outcome);
      await commitMarketDone(mint, coin.creator, job, null);
      return true;
    } catch (error) {
      if (error instanceof MarketUnavailable) {
        console.warn(`predictions: market for prediction ${job.id} is unavailable (${error.message}); points bets stay open`);
        await commitGame(mint, coin.creator, (g, env) => applyMarketUnavailable(g, job.id, now(), env));
        return true;
      }
      console.warn(`predictions: market ${job.kind} for prediction ${job.id} failed (${error instanceof Error ? error.message : "unknown error"}); it is tried again shortly`);
      return false;
    }
  }

  /** Saves a market step's success; a create also registers the market and lists the coin for the close-due sweep, in the same commit. */
  const commitMarketDone = (mint: string, creator: string, job: MarketJob, record: MarketRecord | null) =>
    retryOnConflict(async () => {
      const registry = record ? [marketKey(mint, job.id), OPEN_MARKETS_KEY] : [];
      const { game, save, extra: [presenceDoc, registryDoc, openDoc] } = await readGame(mint, creator, [presenceKey(mint), ...registry]);
      const result = applyMarketDone(game, job, record?.question ?? null, now(), envOf(presenceDoc.json));
      if (!result.changed) return true;
      const docs = save(result.game);
      if (record) {
        docs.push({ key: marketKey(mint, job.id), v: registryDoc.v, json: JSON.stringify(record) });
        const open: string[] = openDoc.json ? JSON.parse(openDoc.json) : [];
        if (!open.includes(mint)) docs.push({ key: OPEN_MARKETS_KEY, v: openDoc.v, json: JSON.stringify([...open, mint]) });
      }
      const status = await store.commit({ docs, ...ledgerChanges(result) });
      return status === "ok" ? true : RETRY;
    });

  /**
   * The cron-safe sweep: for up to `limit` listed coins, runs the clock and every due market step now
   * (closing trading right at lockAt even if nobody is watching), then drops coins whose markets need
   * nothing more. The list rotates BEFORE the work, so a call cut short by a timeout still moves on:
   * the next call starts with other coins.
   */
  async function sweepMarkets(limit: number): Promise<{ swept: number; listed: number }> {
    if (!deps.markets) return { swept: 0, listed: 0 };
    const listed = await retryOnConflict(async () => {
      const [doc] = await store.read([OPEN_MARKETS_KEY]);
      const all: string[] = doc.json ? JSON.parse(doc.json) : [];
      if (all.length <= 1) return all;
      const rotated = [...all.slice(limit), ...all.slice(0, limit)];
      const status = await store.commit({ docs: [{ key: OPEN_MARKETS_KEY, v: doc.v, json: JSON.stringify(rotated) }], moves: [], won: [] });
      return status === "ok" ? all : RETRY;
    });
    const batch = listed.slice(0, limit);
    const done = new Set<string>();
    for (const mint of batch) {
      try {
        const coin = await facts(mint);
        await ticked(mint, coin);
        await runMarketsOnce(mint, coin);
        const { game } = await readGame(mint, coin.creator, []);
        if (!hasPendingMarkets(game)) done.add(mint);
      } catch (error) {
        if (error instanceof UnknownCoinError) done.add(mint);
        else console.warn(`predictions: the market sweep failed on ${mint} (${(error as Error).message})`);
      }
    }
    if (done.size > 0) {
      await retryOnConflict(async () => {
        const [doc] = await store.read([OPEN_MARKETS_KEY]);
        const now: string[] = doc.json ? JSON.parse(doc.json) : [];
        const next = now.filter((m) => !done.has(m));
        if (next.length === now.length) return true;
        const status = await store.commit({ docs: [{ key: OPEN_MARKETS_KEY, v: doc.v, json: JSON.stringify(next) }], moves: [], won: [] });
        return status === "ok" ? true : RETRY;
      });
    }
    return { swept: batch.length, listed: listed.length };
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
      eligible: isEligible(profile),
      role: wallet === game.creator ? "streamer" : game.mods.includes(wallet) ? "mod" : null,
      hasSuggestion: game.suggestions.some((s) => s.asker === wallet),
      holder,
      notice: noticeFor(game, wallet, isStaff(game, wallet)),
      admin: (deps.admins ?? []).includes(wallet),
    };
  }

  async function build(mint: string, wallet: string | null): Promise<PredictionsView> {
    const coin = await facts(mint);
    const { game, env } = await ticked(mint, coin);
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
      pending: staff ? pendingView(game) : null,
      queueSize: visibleSuggestions(game, wallet, staff).length,
      queue: queueView(game, wallet, staff),
      resolved: resolvedView(game, wallet, staff, t, env, me?.admin ?? false),
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

  return { session, beat, act, view, walletOf, reviewDue, aiRun, marketRun, market, staffOf, sweepMarkets };
}

export type PredictionsService = ReturnType<typeof predictionsService>;
