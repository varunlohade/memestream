import { isBase58Of } from "@/lib/base58";
import { parseAction } from "@/server/predictions/input";
import { withRpcGuard } from "@/server/rpc-guard";
import { sharedLimiter } from "@/server/shared-limit";
import { jsonBody, jsonError, ok } from "../../../respond";
import { gate, predictionsError, signedInWallet } from "../../respond";

/** A signed-in wallet's actions, across all its tabs and devices. */
const perWallet = sharedLimiter("predictions-wallet", 10, 1);

/**
 * GET /api/predictions/coin/<mint> (optional session token) -> the coin's predictions: the live
 * one, the queue, recent results, leaderboards, and the signed-in wallet's own points and bets.
 * The coin's streamer comes from the cached, RPC-budgeted coin read.
 */
export const GET = withRpcGuard({ name: "predictions-coin", burst: 30, perSecond: 3 }, async (request: Request, { params }: RouteContext<"/api/predictions/coin/[mint]">) => {
  const service = gate();
  if (service instanceof Response) return service;
  try {
    const { mint } = await params;
    if (!isBase58Of(mint, 32)) return jsonError("Not a valid coin address", 400);
    return ok(await service.view(mint, signedInWallet(service, request)));
  } catch (error) {
    return predictionsError(error);
  }
});

/**
 * POST /api/predictions/coin/<mint> { kind, ... } (session token) -> the updated view.
 * kind: suggest | upvote | bet | launch | remove | resolve | flag | mod | crowd. Free points only; there
 * is no action that buys, sells or sends points.
 */
export const POST = withRpcGuard({ name: "predictions-act", burst: 20, perSecond: 2 }, async (request: Request, { params }: RouteContext<"/api/predictions/coin/[mint]">) => {
  const service = gate();
  if (service instanceof Response) return service;
  const wallet = signedInWallet(service, request);
  if (!wallet) return jsonError("Sign in to play", 401);
  if (!(await perWallet.take(wallet))) return jsonError("Too many requests", 429);
  try {
    const { mint } = await params;
    if (!isBase58Of(mint, 32)) return jsonError("Not a valid coin address", 400);
    const action = parseAction(await jsonBody(request));
    if (!action) return jsonError("Unknown action", 400);
    return ok(await service.act(mint, wallet, action));
  } catch (error) {
    return predictionsError(error);
  }
});
