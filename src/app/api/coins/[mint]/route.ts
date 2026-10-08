import { isBase58Of } from "@/lib/base58";
import { getCoinDetail } from "@/server/coins";
import { withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, jsonError, ok } from "../../respond";

const isAddress = (text: string) => isBase58Of(text, 32);

/**
 * GET /api/coins/<mint>[?wallet=] -> coin, recent trades, and the wallet's holdings.
 * Cache and RPC budget live in getCoinDetail (shared with the server-rendered pages).
 * A page polls every 5 s; the per-client limit allows several tabs and overlays per client.
 */
export const GET = withRpcGuard({ name: "coin", burst: 30, perSecond: 3 }, async (request: Request, { params }: RouteContext<"/api/coins/[mint]">) => {
  try {
    const { mint } = await params;
    const wallet = new URL(request.url).searchParams.get("wallet");
    if (!isAddress(mint)) return jsonError("Not a valid coin address", 400);
    if (wallet !== null && !isAddress(wallet)) return jsonError("Not a valid wallet address", 400);
    const detail = await getCoinDetail(mint, wallet);
    if (!detail) return jsonError("Coin not found", 404);
    return ok(detail);
  } catch (error) {
    return failOrBusy(error);
  }
});
