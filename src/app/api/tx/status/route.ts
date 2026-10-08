import type { TxStatus } from "@/lib/api-types";
import { isBase58Of } from "@/lib/base58";
import { getChain, signatureStatus } from "@/server/chain";
import { UserError } from "@/server/errors";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { fail, jsonError, ok } from "../../respond";

const PUBLIC_URL = (process.env.MEMESTREAM_PUBLIC_URL ?? "").replace(/\/$/, "");
/** One RPC round per transaction every 2 s, however many tabs or clients poll. */
const CACHE_MS = 2_000;
/** Answers this old are dropped from the cache on the next miss. */
const EVICT_AFTER_MS = CACHE_MS * 10;
const cache = new Map<string, { at: number; answer: TxStatus }>();
/** Each cache miss costs 2 RPC calls, drawn from the server-wide budget. */
const RPC_CALLS_PER_MISS = 2;

/**
 * GET /api/tx/status?signature=&blockhash= -> pending | confirmed | failed | expired.
 * Browsers don't send Origin on same-origin GETs, so a cross-site Origin is refused but a missing
 * one is allowed; the per-client limit and the global RPC budget are what bound abuse.
 * A tab polls every 3 s; the per-client limit allows a few tabs plus bursts.
 */
export const GET = withRpcGuard({ name: "tx-status", burst: 20, perSecond: 2 }, async (request: Request, _context: unknown, guard) => {
  const origin = request.headers.get("origin");
  if (origin !== null && origin.replace(/\/$/, "") !== PUBLIC_URL) return jsonError("Forbidden", 403);
  try {
    const query = new URL(request.url).searchParams;
    const signature = query.get("signature") || null;
    const blockhash = query.get("blockhash") ?? "";
    // Strict checks before any RPC call, so made-up keys can't buy free cache misses. The signature is
    // optional: while a wallet hasn't answered yet, only the blockhash is known.
    if (signature !== null && !isBase58Of(signature, 64)) throw new UserError("Not a valid signature");
    if (!isBase58Of(blockhash, 32)) throw new UserError("Not a valid blockhash");

    const key = `${signature}|${blockhash}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return ok(hit.answer);
    if (!(await guard.spend(RPC_CALLS_PER_MISS))) return busy();
    const answer = await signatureStatus(getChain().connection, { signature, blockhash });
    cache.set(key, { at: now, answer });
    for (const [k, v] of cache) if (now - v.at > EVICT_AFTER_MS) cache.delete(k);
    return ok(answer);
  } catch (error) {
    return fail(error);
  }
});
