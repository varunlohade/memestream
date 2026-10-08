import bs58 from "bs58";
import { getChain, signatureStatus } from "@/server/chain";
import { UserError } from "@/server/errors";
import type { TxStatus } from "@/lib/api-types";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { fail, ok } from "../../respond";

/** True if `text` is base58 for exactly `bytes` bytes (64 for a signature, 32 for a blockhash). */
function isBase58Of(text: string, bytes: number): boolean {
  try {
    return bs58.decode(text).length === bytes;
  } catch {
    return false;
  }
}
const PUBLIC_URL = (process.env.MEMESTREAM_PUBLIC_URL ?? "").replace(/\/$/, "");
/** One RPC round per transaction every 2 s, however many tabs or clients poll. */
const CACHE_MS = 2_000;
const cache = new Map<string, { at: number; answer: TxStatus }>();
/** Each cache miss costs 2 RPC calls, drawn from the server-wide budget. */
const RPC_CALLS_PER_MISS = 2;

/**
 * GET /api/tx/status?signature=&blockhash= -> pending | confirmed | failed | expired.
 * Browsers don't send Origin on same-origin GETs, so a cross-site Origin is refused but a missing
 * one is allowed; the per-client limit and the global RPC budget are what bound abuse.
 */
// A tab polls every 3 s; the per-client limit allows a few tabs plus bursts.
export const GET = withRpcGuard({ burst: 20, perSecond: 2 }, async (request: Request, _context: unknown, guard) => {
  const origin = request.headers.get("origin");
  if (origin !== null && origin.replace(/\/$/, "") !== PUBLIC_URL) return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    const q = new URL(request.url).searchParams;
    const signature = q.get("signature") || null;
    const blockhash = q.get("blockhash") ?? "";
    // Strict checks before any RPC call, so made-up keys can't buy free cache misses. The signature is
    // optional: while a wallet hasn't answered yet, only the blockhash is known.
    if (signature !== null && !isBase58Of(signature, 64)) throw new UserError("Not a valid signature");
    if (!isBase58Of(blockhash, 32)) throw new UserError("Not a valid blockhash");

    const key = `${signature}|${blockhash}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return ok(hit.answer);
    if (!guard.spend(RPC_CALLS_PER_MISS)) return busy();
    const answer = await signatureStatus(getChain().connection, { signature, blockhash });
    cache.set(key, { at: now, answer });
    for (const [k, v] of cache) if (now - v.at > CACHE_MS * 10) cache.delete(k);
    return ok(answer);
  } catch (error) {
    return fail(error);
  }
});
