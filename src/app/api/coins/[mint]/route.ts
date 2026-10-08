import bs58 from "bs58";
import { getCoinDetail } from "@/server/coins";
import { BusyError } from "@/server/errors";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { fail, ok } from "../../respond";

const isPubkey = (text: string) => {
  try {
    return bs58.decode(text).length === 32;
  } catch {
    return false;
  }
};

/**
 * GET /api/coins/<mint>[?wallet=] -> coin, recent trades, and the wallet's holdings.
 * Cache and RPC budget live in getCoinDetail (shared with the server-rendered pages).
 * A page polls every 5 s; the per-client limit allows several tabs and overlays per client.
 */
export const GET = withRpcGuard({ burst: 30, perSecond: 3 }, async (request: Request, { params }: { params: Promise<{ mint: string }> }) => {
  try {
    const { mint } = await params;
    const wallet = new URL(request.url).searchParams.get("wallet");
    if (!isPubkey(mint)) return Response.json({ error: "Not a valid coin address" }, { status: 400 });
    if (wallet !== null && !isPubkey(wallet)) return Response.json({ error: "Not a valid wallet address" }, { status: 400 });
    const detail = await getCoinDetail(mint, wallet);
    if (!detail) return Response.json({ error: "Coin not found" }, { status: 404 });
    return ok(detail);
  } catch (error) {
    return error instanceof BusyError ? busy() : fail(error);
  }
});
