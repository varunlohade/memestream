import { cronAuthorized } from "@/server/cron-auth";
import { busy, type RpcGuard, withRpcGuard } from "@/server/rpc-guard";
import { jsonError, ok } from "../../respond";
import { gate, predictionsError } from "../respond";

/** Seconds a sweep may run: each coin's AI steps (frame, description, jev) have their own timeouts, well under this. */
export const maxDuration = 60;
/** Coins swept per call (a random pick of those with a live prediction, so each gets its turn). */
const COINS_PER_CALL = 10;
/** RPC calls drawn per coin: its cached coin facts and the tick's reads. */
const RPC_CALLS_PER_COIN = 2;

async function sweep(request: Request, guard: RpcGuard): Promise<Response> {
  if (!cronAuthorized(request)) return jsonError("Not found", 404);
  const service = gate();
  if (service instanceof Response) return service;
  if (!(await guard.spend(COINS_PER_CALL * RPC_CALLS_PER_COIN))) return busy();
  try {
    return ok(await service.sweepLive(COINS_PER_CALL));
  } catch (error) {
    return predictionsError(error);
  }
}

/**
 * /api/predictions/tick -> { swept, listed }, for a scheduler (Vercel Cron every minute): POST with
 * x-cron-secret, or GET as Vercel Cron sends it. Grabs stream frames and runs the AI referee for live
 * predictions even when nobody watches the coin, and runs their clock.
 */
export const POST = withRpcGuard({ name: "predictions-tick", burst: 2, perSecond: 1 }, (request: Request, _context: unknown, guard) => sweep(request, guard));
export const GET = withRpcGuard({ name: "predictions-tick-get", burst: 2, perSecond: 1 }, (request: Request, _context: unknown, guard) => sweep(request, guard));
