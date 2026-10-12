import { liveFeed } from "@/server/live-predictions";
import { withRpcGuard } from "@/server/rpc-guard";
import { ok } from "../../respond";
import { gate, predictionsError } from "../respond";

/**
 * GET /api/predictions/live -> { now, items }: predictions open for bets across coins (home page
 * row), soonest to close first. Cached 5 s per server instance; at most one RPC call per refresh,
 * and only when a shown prediction has an open market.
 */
export const GET = withRpcGuard({ name: "predictions-live", burst: 20, perSecond: 2 }, async (_request: Request, _context: unknown, guard) => {
  const service = gate();
  if (service instanceof Response) return service;
  try {
    return ok(await liveFeed(service, guard.spend));
  } catch (error) {
    return predictionsError(error);
  }
});
