import { timingSafeEqual } from "node:crypto";
import { marketsEnabled, predictions } from "@/server/predictions";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { jsonError, ok } from "../../respond";

/** Coins swept per call: each can send a few oracle transactions, so a call stays well inside a function's time limit. */
const COINS_PER_CALL = 10;
/** RPC calls drawn per coin: the tick's reads, a close (pool, position, blockhash, status polls) and a resolve. */
const RPC_CALLS_PER_COIN = 20;
const MIN_SECRET_CHARS = 32;

/** Constant-time comparison of the x-cron-secret header with MEMESTREAM_CRON_SECRET (unset or short: the route is off). */
function authorized(request: Request): boolean {
  const secret = process.env.MEMESTREAM_CRON_SECRET ?? "";
  const given = request.headers.get("x-cron-secret") ?? "";
  if (secret.length < MIN_SECRET_CHARS) return false;
  const [a, b] = [Buffer.from(given), Buffer.from(secret)];
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /api/markets/close-due (header x-cron-secret) -> { swept, listed }: for a scheduler. Runs every
 * due market step now (closing trading right at lockAt even when nobody watches the coin), for up to
 * COINS_PER_CALL coins with markets still open; the rest wait for the next call.
 */
export const POST = withRpcGuard({ name: "markets-close-due", burst: 2, perSecond: 1 }, async (request: Request, _context: unknown, guard) => {
  if (!authorized(request)) return jsonError("Not found", 404);
  if (!marketsEnabled()) return ok({ swept: 0, listed: 0 });
  const ready = predictions();
  if (!("service" in ready)) return jsonError(ready.error, 503);
  if (!(await guard.spend(COINS_PER_CALL * RPC_CALLS_PER_COIN))) return busy();
  return ok(await ready.service.sweepMarkets(COINS_PER_CALL));
});
