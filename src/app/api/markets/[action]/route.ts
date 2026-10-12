import { buildMarketRedeemForWallet, buildMarketTradeForWallet, getMarket, previewMarketTrade } from "@/server/markets";
import { type MarketAction, parseMarketRequest } from "@/server/market-requests";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, jsonBody, ok } from "../../respond";

/**
 * RPC calls each action makes, charged after the request parses so a bad request costs nothing.
 * Each pool read is the pool plus the clock (x2 pools); the question is one more; a build adds the
 * blockhash; redeem reads the question, the wallet's two token accounts (one call) and a blockhash.
 */
const RPC_CALLS: Record<MarketAction, number> = { odds: 5, preview: 4, trade: 5, redeem: 3 };

export const POST = withRpcGuard({ name: "markets", burst: 10, perSecond: 1 }, async (request: Request, { params }: RouteContext<"/api/markets/[action]">, guard) => {
  try {
    const parsed = parseMarketRequest((await params).action, await jsonBody(request));
    if (!(await guard.spend(RPC_CALLS[parsed.action]))) return busy();
    switch (parsed.action) {
      case "odds":
        return ok(await getMarket(parsed.req));
      case "preview":
        return ok(await previewMarketTrade(parsed.req));
      case "trade":
        return ok(await buildMarketTradeForWallet(parsed.req));
      case "redeem":
        return ok(await buildMarketRedeemForWallet(parsed.req));
    }
  } catch (error) {
    return failOrBusy(error);
  }
});
