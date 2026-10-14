/**
 * Storage for free-points predictions: Upstash Redis in production (shared by every server
 * instance), or in-memory maps for local development only.
 *
 * Two kinds of data:
 * - Documents (a coin's game, one live prediction, a wallet's watch record): JSON with a version number.
 * - The ledger: every wallet's points balance, plus all-time net winnings for the leaderboard.
 *
 * All writes go through one atomic commit: refuse a nonce already used ("replay"), check every
 * document's version (someone else changed it: "conflict", the caller re-reads and retries), check
 * every balance floor, then use up the nonce, move the points and save (or delete) the documents. The nonce is
 * checked first, so a commit re-sent after it already landed answers "replay", not "conflict"; it
 * is used up last, so a refused commit can try again with the same nonce. In Redis that is one Lua script; in memory it is
 * synchronous code with no await between the checks and the writes. store.test.ts runs both.
 *
 * Points only ever move by commits the game engine computes. There is deliberately no way to buy,
 * sell or send points between wallets.
 */
import type { Redis } from "@upstash/redis";
import { byPoints } from "@/lib/predictions/rules";
import { DEFAULT_PREFIX } from "./test-settings";

export type Doc = { v: number; json: string | null };
export type Move = { wallet: string; delta: number; floor: number };
export type Commit = {
  /**
   * Documents to save, each with the version it was read at; `ttlMs` makes it expire (then it reads as new).
   * `json: null` deletes the document (then it reads as new).
   */
  docs: { key: string; v: number; json: string | null; ttlMs?: number }[];
  /** A one-time key (signed-message nonce, or a request's idempotency id): refused as "replay" if a commit with it succeeded within ttlMs. */
  nonce?: { key: string; ttlMs: number };
  /** Balance changes; each needs the balance to be at least `floor` before, and never below 0 after. */
  moves: Move[];
  /** All-time net winnings changes (leaderboard). */
  won: { wallet: string; delta: number }[];
  /** Set memberships to add (`add`) or remove, applied only if the commit succeeds (the live-coins index). */
  sets?: SetChange[];
};
export type SetChange = { key: string; member: string; add: boolean };
export type CommitResult = "ok" | "conflict" | "replay" | "insufficient";
export type Leader = { wallet: string; points: number };

export interface PredictionStore {
  readonly kind: "redis" | "memory";
  read(keys: string[]): Promise<Doc[]>;
  commit(commit: Commit): Promise<CommitResult>;
  balances(wallets: string[]): Promise<number[]>;
  /** Wallets by all-time net winnings, highest first. */
  topWon(limit: number): Promise<Leader[]>;
  /** The members of a set that commits keep (`Commit.sets`), in no particular order. */
  members(key: string): Promise<string[]>;
  /**
   * Takes one from each counter in `keys`, in one atomic step, unless any is already at its limit
   * (`limits[i]`); false then, and nothing is taken. Each counter expires `ttlMs` after its last take.
   * No version check: concurrent takes never conflict.
   */
  take(keys: string[], limits: number[], ttlMs: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------
// In-memory store: DEV ONLY. One process, lost on restart, not shared between server instances.
// ---------------------------------------------------------------------------------------------

export function memoryStore(now: () => number = Date.now): PredictionStore {
  const docs = new Map<string, { v: number; json: string; until: number }>();
  /** A document, unless it has expired. */
  const live = (key: string) => {
    const doc = docs.get(key);
    if (doc && doc.until <= now()) docs.delete(key);
    return docs.get(key);
  };
  const balances = new Map<string, number>();
  const won = new Map<string, number>();
  const nonces = new Map<string, number>(); // key -> expires at
  const sets = new Map<string, Set<string>>();
  const counters = new Map<string, { n: number; until: number }>();

  return {
    kind: "memory",
    async read(keys) {
      return keys.map((key) => {
        const doc = live(key);
        return doc ? { v: doc.v, json: doc.json } : { v: 0, json: null };
      });
    },
    // Synchronous body: nothing else runs between the checks and the writes.
    async commit(c) {
      if (c.nonce) {
        const t = now();
        for (const [key, until] of nonces) if (until <= t) nonces.delete(key);
        if (nonces.has(c.nonce.key)) return "replay";
      }
      for (const d of c.docs) if ((live(d.key)?.v ?? 0) !== d.v) return "conflict";
      for (const m of c.moves) {
        const balance = balances.get(m.wallet) ?? 0;
        if (balance < m.floor || balance + m.delta < 0) return "insufficient";
      }
      if (c.nonce) nonces.set(c.nonce.key, now() + c.nonce.ttlMs);
      for (const m of c.moves) balances.set(m.wallet, (balances.get(m.wallet) ?? 0) + m.delta);
      for (const w of c.won) won.set(w.wallet, (won.get(w.wallet) ?? 0) + w.delta);
      for (const d of c.docs) {
        if (d.json === null) docs.delete(d.key);
        else docs.set(d.key, { v: d.v + 1, json: d.json, until: d.ttlMs ? now() + d.ttlMs : Infinity });
      }
      for (const s of c.sets ?? []) {
        const set = sets.get(s.key) ?? sets.set(s.key, new Set()).get(s.key)!;
        if (s.add) set.add(s.member);
        else set.delete(s.member);
      }
      return "ok";
    },
    async balances(wallets) {
      return wallets.map((w) => balances.get(w) ?? 0);
    },
    async topWon(limit) {
      return [...won]
        .map(([wallet, points]) => ({ wallet, points }))
        .sort(byPoints)
        .slice(0, limit);
    },
    async members(key) {
      return [...(sets.get(key) ?? [])];
    },
    async take(keys, limits, ttlMs) {
      const counts = keys.map((k) => (counters.get(k)?.until ?? 0) > now() ? counters.get(k)!.n : 0);
      if (counts.some((n, i) => n >= limits[i])) return false;
      keys.forEach((k, i) => counters.set(k, { n: counts[i] + 1, until: now() + ttlMs }));
      return true;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Redis store: the same steps as Lua scripts, which Redis runs atomically.
// ---------------------------------------------------------------------------------------------

/**
 * KEYS: balances, won, the documents..., the nonce key if any, then one key per set change.
 * ARGV: docCount, hasNonce, nonceTtlMs, (v, json, ttlMs or 0, delete '1' or '0') per document, setCount,
 * (member, add '1' or '0') per set change, moveCount, (wallet, delta, floor) per move, then (wallet, delta)
 * per winnings change.
 */
export const COMMIT_LUA = `
local docCount = tonumber(ARGV[1])
local nonceKey = KEYS[3 + docCount]
if ARGV[2] == '1' and redis.call('EXISTS', nonceKey) == 1 then return 'replay' end
local i = 4
for d = 1, docCount do
  local current = redis.call('HGET', KEYS[2 + d], 'v') or '0'
  if current ~= ARGV[i] then return 'conflict' end
  i = i + 4
end
local setCount = tonumber(ARGV[i])
local firstSet = i + 1
local firstSetKey = 3 + docCount + tonumber(ARGV[2])
i = firstSet + 2 * setCount
local moveCount = tonumber(ARGV[i])
i = i + 1
local firstMove = i
for m = 1, moveCount do
  local balance = tonumber(redis.call('HGET', KEYS[1], ARGV[i]) or '0')
  local delta, floor = tonumber(ARGV[i + 1]), tonumber(ARGV[i + 2])
  if balance < floor or balance + delta < 0 then return 'insufficient' end
  i = i + 3
end
if ARGV[2] == '1' then redis.call('SET', nonceKey, '1', 'PX', ARGV[3]) end
i = firstMove
for m = 1, moveCount do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
  i = i + 3
end
while i <= #ARGV do
  redis.call('ZINCRBY', KEYS[2], ARGV[i + 1], ARGV[i])
  i = i + 2
end
i = 4
for d = 1, docCount do
  if ARGV[i + 3] == '1' then
    redis.call('DEL', KEYS[2 + d])
  else
    redis.call('HSET', KEYS[2 + d], 'v', tostring(tonumber(ARGV[i]) + 1), 'json', ARGV[i + 1])
    if tonumber(ARGV[i + 2]) > 0 then redis.call('PEXPIRE', KEYS[2 + d], ARGV[i + 2]) end
  end
  i = i + 4
end
for s = 0, setCount - 1 do
  local member, add = ARGV[firstSet + 2 * s], ARGV[firstSet + 2 * s + 1]
  if add == '1' then redis.call('SADD', KEYS[firstSetKey + s], member) else redis.call('SREM', KEYS[firstSetKey + s], member) end
end
return 'ok'
`;

/** KEYS: documents. Returns { {v, json}... } (false where missing). */
export const READ_LUA = `
local out = {}
for k = 1, #KEYS do out[k] = redis.call('HMGET', KEYS[k], 'v', 'json') end
return out
`;

/** KEYS: balances. ARGV: wallets. */
export const BALANCES_LUA = `
local out = {}
for k = 1, #ARGV do out[k] = redis.call('HGET', KEYS[1], ARGV[k]) or '0' end
return out
`;

/** KEYS: a set. */
export const MEMBERS_LUA = `return redis.call('SMEMBERS', KEYS[1])`;

/** KEYS: counters (hashes with field n). ARGV: ttlMs, then each counter's limit. Returns 1 if taken, 0 if any is at its limit. */
export const TAKE_LUA = `
for i, key in ipairs(KEYS) do
  local n = tonumber(redis.call('HGET', key, 'n') or '0') or 0
  if n >= tonumber(ARGV[i + 1]) then return 0 end
end
for _, key in ipairs(KEYS) do
  redis.call('HINCRBY', key, 'n', 1)
  redis.call('PEXPIRE', key, ARGV[1])
end
return 1`;

/** KEYS: won. ARGV: limit. */
export const TOP_LUA = `return redis.call('ZREVRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1, 'WITHSCORES')`;

const present = (value: unknown) => value !== null && value !== undefined && value !== false;

/**
 * `redis` should be created with automaticDeserialization: false, so JSON stays text until parsed here.
 * Every key starts with `prefix` (a test run uses its own; see test-settings.ts).
 */
export function redisStore(redis: Redis, prefix = DEFAULT_PREFIX): PredictionStore {
  const BALANCES = `${prefix}balance`;
  const WON = `${prefix}won`;
  const run = <T>(script: string, keys: string[], args: (string | number)[]) => redis.eval<string[], T>(script, keys, args.map(String));
  return {
    kind: "redis",
    async read(keys) {
      if (keys.length === 0) return [];
      const rows = await run<[unknown, unknown][]>(READ_LUA, keys.map((k) => prefix + k), []);
      return keys.map((_, i) => {
        const [v, json] = rows?.[i] ?? [];
        return present(json) ? { v: Number(v), json: String(json) } : { v: 0, json: null };
      });
    },
    async commit(c) {
      const sets = c.sets ?? [];
      const keys = [BALANCES, WON, ...c.docs.map((d) => prefix + d.key), ...(c.nonce ? [prefix + c.nonce.key] : []), ...sets.map((s) => prefix + s.key)];
      const args = [
        c.docs.length,
        c.nonce ? 1 : 0,
        c.nonce?.ttlMs ?? 0,
        ...c.docs.flatMap((d) => [d.v, d.json ?? "", d.ttlMs ?? 0, d.json === null ? 1 : 0]),
        sets.length,
        ...sets.flatMap((s) => [s.member, s.add ? 1 : 0]),
        c.moves.length,
        ...c.moves.flatMap((m) => [m.wallet, m.delta, m.floor]),
        ...c.won.flatMap((w) => [w.wallet, w.delta]),
      ];
      const result = await run<string>(COMMIT_LUA, keys, args);
      if (result === "ok" || result === "conflict" || result === "replay" || result === "insufficient") return result;
      throw new Error(`unexpected commit result: ${String(result)}`);
    },
    async balances(wallets) {
      if (wallets.length === 0) return [];
      const values = await run<unknown[]>(BALANCES_LUA, [BALANCES], wallets);
      return wallets.map((_, i) => Number(values?.[i] ?? 0));
    },
    async topWon(limit) {
      const flat = (await run<unknown[]>(TOP_LUA, [WON], [limit])) ?? [];
      const leaders: Leader[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) leaders.push({ wallet: String(flat[i]), points: Number(flat[i + 1]) });
      return leaders;
    },
    async members(key) {
      return ((await run<unknown[]>(MEMBERS_LUA, [prefix + key], [])) ?? []).map(String);
    },
    async take(keys, limits, ttlMs) {
      return Number(await run<unknown>(TAKE_LUA, keys.map((k) => prefix + k), [ttlMs, ...limits])) === 1;
    },
  };
}
