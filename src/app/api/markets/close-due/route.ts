import { cronAuthorized } from "@/server/cron-auth";
import { marketsEnabled, predictions } from "@/server/predictions";
import { busy, type RpcGuard, withRpcGuard } from "@/server/rpc-guard";
import { jsonError, ok } from "../../respond";

/** Seconds a sweep may run: each coin can send a few oracle transactions (up to 60 s each to confirm). */
export const maxDuration = 300;
/** Coins swept per call, so a call stays inside maxDuration; the list rotates, so the rest come next. */
const COINS_PER_CALL = 4;
/** RPC calls drawn per coin: the tick's reads, a close (pool, position, blockhash, status polls) and a resolve. */
const RPC_CALLS_PER_COIN = 20;

async function sweep(request: Request, guard: RpcGuard): Promise<Response> {
  if (!cronAuthorized(request)) return jsonError("Not found", 404);
  if (!marketsEnabled()) return ok({ swept: 0, listed: 0 });
  const ready = predictions();
  if (!("service" in ready)) return jsonError(ready.error, 503);
  if (!(await guard.spend(COINS_PER_CALL * RPC_CALLS_PER_COIN))) return busy();
  return ok(await ready.service.sweepMarkets(COINS_PER_CALL));
}

/**
 * /api/markets/close-due -> { swept, listed }, for a scheduler: POST with x-cron-secret, or GET as
 * Vercel Cron sends it. Runs every due market step now (closing trading right at lockAt even when
 * nobody watches the coin), for up to COINS_PER_CALL coins with markets still open.
 */
export const POST = withRpcGuard({ name: "markets-close-due", burst: 2, perSecond: 1 }, (request: Request, _context: unknown, guard) => sweep(request, guard));
export const GET = withRpcGuard({ name: "markets-close-due-get", burst: 2, perSecond: 1 }, (request: Request, _context: unknown, guard) => sweep(request, guard));
