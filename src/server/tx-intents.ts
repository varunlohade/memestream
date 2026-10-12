/**
 * Server-side guard against paying twice: the same wallet asking to build the same transaction
 * (same action and inputs) while an earlier one, built within INTENT_WINDOW_MS, is signed but not
 * yet confirmed, failed or expired gets a 409. The client reports each intent's signature through
 * the status poll (?intent=), so a built-but-rejected transaction never counts as pending.
 *
 * State lives in the shared Redis (one record per wallet + intent, expiring with the blockhash);
 * without Redis, or while it is down, each instance keeps its own in-memory copy. Any store error
 * lets the trade through: this is a convenience check, the chain is still the source of truth.
 */
import { createHash, randomUUID } from "node:crypto";
import type { TxStatus } from "@/lib/api-types";
import type { ParsedTx } from "./requests";
import { sharedRedis } from "./shared-limit";

/** A blockhash's longest life (150 blocks, with margin): after it, the transaction can't land. */
export const INTENT_WINDOW_MS = 90_000;
/** Records outlive the window a little, so a late status report still finds its record. */
const RECORD_TTL_MS = 150_000;
const REDIS_TIMEOUT_MS = 800;
const REDIS_PAUSE_MS = 30_000;
const PREFIX = "memestream:intent:";

export type IntentRecord = { id: string; blockhash: string; at: number; signature: string | null };

export type IntentStore = {
  get: (key: string) => Promise<IntentRecord | null>;
  set: (key: string, record: IntentRecord, ttlMs: number) => Promise<void>;
  del: (key: string) => Promise<void>;
};

export function memoryIntentStore(clock: () => number = Date.now): IntentStore {
  const records = new Map<string, { record: IntentRecord; until: number }>();
  return {
    async get(key) {
      const hit = records.get(key);
      if (hit && hit.until > clock()) return hit.record;
      records.delete(key);
      return null;
    },
    async set(key, record, ttlMs) {
      const now = clock();
      for (const [k, v] of records) if (v.until <= now) records.delete(k);
      records.set(key, { record, until: now + ttlMs });
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
    del: (key) => viaRedis(async (r) => void (await r.del(PREFIX + key)), () => local.del(key)),
  };
}

/** Who and what: the wallet, the action and its inputs. Slippage and the quoted minimum don't make a trade different. */
export function intentKey(parsed: ParsedTx): string {
  const inputs = parsed.req as Record<string, unknown>;
  const sorted = Object.keys(inputs)
    .filter((k) => k !== "slippageBps" && k !== "minReceived")
    .sort()
    .map((k) => [k, inputs[k]]);
  return createHash("sha256").update(JSON.stringify([parsed.action, sorted])).digest("hex").slice(0, 32);
}

const TOKEN = /^([0-9a-f]{32})\.([0-9a-f-]{36})$/;
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
    /** The pending signature of an identical intent, or null if this one may go ahead. */
    pending: (key: string, now: number) =>
      safely(async () => {
        const record = await store.get(key);
        return record?.signature && now - record.at < INTENT_WINDOW_MS ? record.signature : null;
      }, null),

    /** Records a freshly built intent; the token goes back to the client for its status polls. */
    remember: async (key: string, blockhash: string, now: number) => {
      const id = randomUUID();
      await safely(() => store.set(key, { id, blockhash, at: now, signature: null }, RECORD_TTL_MS), undefined);
      return `${key}.${id}`;
    },

    /** From a status poll: the signature makes the intent pending; a final answer ends it. */
    report: (token: string, blockhash: string, signature: string | null, status: TxStatus["status"], now: number) =>
      safely(async () => {
        const match = TOKEN.exec(token);
        if (!match) return;
        const [, key, id] = match;
        const record = await store.get(key);
        if (!record || record.id !== id || record.blockhash !== blockhash) return;
        if (status !== "pending") return store.del(key);
        const left = RECORD_TTL_MS - (now - record.at);
        if (signature && !record.signature && left > 0) await store.set(key, { ...record, signature }, left);
      }, undefined),
  };
}

export const DUPLICATE_MESSAGE = "Your last trade is still confirming. Check your wallet before trading again.";
export const duplicateResponse = (pendingSignature: string) =>
  Response.json({ error: DUPLICATE_MESSAGE, duplicate: true, pendingSignature }, { status: 409 });

let shared: ReturnType<typeof txIntents> | undefined;
export const intents = () => (shared ??= txIntents(sharedIntentStore()));
