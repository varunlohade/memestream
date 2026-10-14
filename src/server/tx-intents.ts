/**
 * Server-side guard against paying twice: the same wallet asking to build the same transaction
 * (same action and inputs, amount compared in base units) gets a 409 while an earlier one is held:
 * - from its build for BUILD_HOLD_MS (the wallet popup), so a second tab or a reload can't build it again;
 *   a signature reported after that hold lapsed (a slow popup) holds it again;
 * - once the client reports its signature (status poll, ?intent=), until SIGNED_HOLD_MS after the build;
 * - until it's confirmed, failed or expired (status poll), or the wallet rejected it (/api/tx/rejected).
 * A record is only ever added if none exists (never overwritten), so two racing builds can't both pass.
 *
 * State lives in the shared Redis (one record per wallet + intent, expiring on its own);
 * without Redis, or while it is down, each instance keeps its own in-memory copy. Any store error
 * lets the trade through: this is a convenience check, the chain is still the source of truth.
 */
import { createHash, randomUUID } from "node:crypto";
import { SOL_DECIMALS, type TxStatus } from "@/lib/api-types";
import { BASE_DECIMALS, parseUnits } from "@/lib/dbc/units";
import { OUTCOME_DECIMALS } from "@/lib/markets/pool";
import type { ParsedTx } from "./requests";
import { sharedRedis } from "./shared-limit";

/** Held from the build while the wallet popup is open; a client that never reports lets it lapse. */
export const BUILD_HOLD_MS = 60_000;
/** Held once signed: past the blockhash's life (~90 s) plus the grace a wallet's own blockhash may take. */
export const SIGNED_HOLD_MS = 150_000;
const REDIS_TIMEOUT_MS = 800;
const REDIS_PAUSE_MS = 30_000;
const PREFIX = "memestream:intent:";

export type IntentRecord = { id: string; blockhash: string; at: number; signature: string | null };

export type IntentStore = {
  get: (key: string) => Promise<IntentRecord | null>;
  set: (key: string, record: IntentRecord, ttlMs: number) => Promise<void>;
  /** Adds the record only if the key has none; false if one exists. */
  add: (key: string, record: IntentRecord, ttlMs: number) => Promise<boolean>;
  del: (key: string) => Promise<void>;
};

export function memoryIntentStore(clock: () => number = Date.now): IntentStore {
  const records = new Map<string, { record: IntentRecord; until: number }>();
  const get = (key: string) => {
    const hit = records.get(key);
    if (hit && hit.until > clock()) return hit.record;
    records.delete(key);
    return null;
  };
  const set = (key: string, record: IntentRecord, ttlMs: number) => {
    const now = clock();
    for (const [k, v] of records) if (v.until <= now) records.delete(k);
    records.set(key, { record, until: now + ttlMs });
  };
  return {
    get: async (key) => get(key),
    set: async (key, record, ttlMs) => set(key, record, ttlMs),
    async add(key, record, ttlMs) {
      if (get(key)) return false;
      set(key, record, ttlMs);
      return true;
    },
    async del(key) {
      records.delete(key);
    },
  };
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("Redis timeout")), REDIS_TIMEOUT_MS)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Redis when configured and answering; the in-memory store otherwise. */
export function sharedIntentStore(): IntentStore {
  const local = memoryIntentStore();
  let downUntil = 0;
  const viaRedis = async <T>(remote: (redis: NonNullable<ReturnType<typeof sharedRedis>>) => Promise<T>, fallback: () => Promise<T>) => {
    const redis = Date.now() >= downUntil ? sharedRedis() : null;
    if (redis) {
      try {
        return await withTimeout(remote(redis));
      } catch (error) {
        downUntil = Date.now() + REDIS_PAUSE_MS;
        console.warn(`tx intents: Redis unavailable for ${REDIS_PAUSE_MS / 1000} s, using local:`, (error as Error).message);
      }
    }
    return fallback();
  };
  return {
    get: (key) => viaRedis((r) => r.get<IntentRecord>(PREFIX + key), () => local.get(key)),
    set: (key, record, ttlMs) => viaRedis(async (r) => void (await r.set(PREFIX + key, record, { px: ttlMs })), () => local.set(key, record, ttlMs)),
    add: (key, record, ttlMs) => viaRedis(async (r) => (await r.set(PREFIX + key, record, { px: ttlMs, nx: true })) === "OK", () => local.add(key, record, ttlMs)),
    del: (key) => viaRedis(async (r) => void (await r.del(PREFIX + key)), () => local.del(key)),
  };
}

/** The decimals an amount is sent in: SOL in for a buy, coins or outcome shares out for a sell. */
function amountDecimals(parsed: ParsedTx): number | null {
  if (parsed.action === "trade") return parsed.req.side === "buy" ? SOL_DECIMALS : BASE_DECIMALS;
  if (parsed.action === "market") return parsed.req.action === "buy" ? SOL_DECIMALS : OUTCOME_DECIMALS;
  return null;
}

/** "0.1", "0.10" and ".1" are one amount: compare base units. Bad input stays as typed (the build refuses it). */
function normalAmount(amount: string, decimals: number): string {
  const text = amount.trim();
  try {
    return parseUnits(text.startsWith(".") ? `0${text}` : text, decimals).toString();
  } catch {
    return amount;
  }
}

/** Who and what: the wallet, the action and its inputs. Slippage and the quoted minimum don't make a trade different. */
export function intentKey(parsed: ParsedTx): string {
  const decimals = amountDecimals(parsed);
  const inputs: Record<string, unknown> = { ...parsed.req };
  if (decimals !== null && typeof inputs.amount === "string") inputs.amount = normalAmount(inputs.amount, decimals);
  const sorted = Object.keys(inputs)
    .filter((k) => k !== "slippageBps" && k !== "minReceived")
    .sort()
    .map((k) => [k, inputs[k]]);
  return createHash("sha256").update(JSON.stringify([parsed.action, sorted])).digest("hex").slice(0, 32);
}

const TOKEN = /^([0-9a-f]{32})\.([0-9a-f-]{36})$/;
/** Where the build's issuance is kept (same store, its own key), so reports can be checked against it. */
const issuedKey = (key: string, id: string) => `issued:${key}.${id}`;
export const isIntentToken = (token: string) => TOKEN.test(token);

export function txIntents(store: IntentStore) {
  const safely = async <T>(work: () => Promise<T>, otherwise: T): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      console.warn("tx intents:", (error as Error).message);
      return otherwise;
    }
  };
  return {
    /** The identical intent still held (its signature may be null: the popup is still open), or null. */
    pending: (key: string, now: number) =>
      safely(async () => {
        const record = await store.get(key);
        if (!record) return null;
        return now - record.at < (record.signature ? SIGNED_HOLD_MS : BUILD_HOLD_MS) ? { signature: record.signature } : null;
      }, null),

    /**
     * Holds a freshly built intent. Returns the token the client sends back on its status polls,
     * or null if an identical intent got there first (answer 409). A store error lets it through.
     */
    remember: async (key: string, blockhash: string, now: number): Promise<string | null> => {
      const id = randomUUID();
      const record = { id, blockhash, at: now, signature: null };
      const added = await safely(() => store.add(key, record, BUILD_HOLD_MS), true);
      if (!added) return null;
      // What this server issued, kept past the build hold: a late report may only revive a real build.
      await safely(() => store.set(issuedKey(key, id), record, SIGNED_HOLD_MS), undefined);
      return `${key}.${id}`;
    },

    /** The wallet rejected it: nothing was signed, so the same trade may be built again at once. */
    release: (token: string) =>
      safely(async () => {
        const match = TOKEN.exec(token);
        if (!match) return;
        const [, key, id] = match;
        const record = await store.get(key);
        if (record && record.id === id && !record.signature) await store.del(key);
      }, undefined),

    /** From a status poll: the signature makes the intent pending; a final answer ends it. */
    report: (token: string, blockhash: string, signature: string | null, status: TxStatus["status"], now: number) =>
      safely(async () => {
        const match = TOKEN.exec(token);
        if (!match) return;
        const [, key, id] = match;
        const record = await store.get(key);
        if (!record) {
          // The popup outlasted the build hold. Hold it again only for an intent this server really
          // built with this blockhash (never from a token someone made up), until SIGNED_HOLD_MS after
          // that build. Never overwrites.
          if (!signature || status !== "pending") return;
          const issued = await store.get(issuedKey(key, id));
          if (!issued || issued.id !== id || issued.blockhash !== blockhash) return;
          const left = SIGNED_HOLD_MS - (now - issued.at);
          if (left > 0) await store.add(key, { ...issued, signature }, left);
          return;
        }
        if (record.id !== id || record.blockhash !== blockhash) return;
        if (status !== "pending") return store.del(key);
        const left = SIGNED_HOLD_MS - (now - record.at);
        if (signature && !record.signature && left > 0) await store.set(key, { ...record, signature }, left);
      }, undefined),
  };
}

export const DUPLICATE_MESSAGE = "Your last trade is still confirming. Check your wallet before trading again.";
export const duplicateResponse = (pendingSignature: string | null) =>
  Response.json({ error: DUPLICATE_MESSAGE, duplicate: true, pendingSignature }, { status: 409 });

let shared: ReturnType<typeof txIntents> | undefined;
export const intents = () => (shared ??= txIntents(sharedIntentStore()));
