import { isBase58Of } from "@/lib/base58";
import { getHolders } from "@/server/coins";
import { withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, jsonError, ok } from "../../../respond";

/**
 * GET /api/coins/<mint>/holders -> { holders }: the coin's largest holders, with their share of supply.
 * Cache (30 s per coin) and RPC budget (2 calls per read) live in getHolders.
 */
export const GET = withRpcGuard({ name: "holders", burst: 20, perSecond: 2 }, async (_request: Request, { params }: RouteContext<"/api/coins/[mint]/holders">) => {
  try {
    const { mint } = await params;
    if (!isBase58Of(mint, 32)) return jsonError("Not a valid coin address", 400);
    const holders = await getHolders(mint);
    if (!holders) return jsonError("Coin not found", 404);
    return ok({ holders });
  } catch (error) {
    return failOrBusy(error);
  }
});
