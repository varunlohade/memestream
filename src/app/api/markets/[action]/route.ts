import { buildMarketRedeemForWallet, buildMarketTradeForWallet, getMarket, previewMarketTrade } from "@/server/markets";
import { registeredMarket } from "@/server/predictions";
import { type MarketAction, parseMarketRequest } from "@/server/market-requests";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, jsonBody, ok } from "../../respond";

/**
 * RPC calls each action makes, charged after the request parses so a bad request costs nothing.
 * Each pool read is the pool plus the clock (x2 pools); the question is one more; odds with a wallet
 * reads its two token accounts and balance (one call); a build adds the blockhash; redeem also reads
 * the wallet's two token accounts. Only registered markets (the oracle made them) get this far.
 */
const RPC_CALLS: Record<MarketAction, number> = { odds: 6, preview: 5, trade: 6, redeem: 8 };

export const POST = withRpcGuard({ name: "markets", burst: 10, perSecond: 1 }, async (request: Request, { params }: RouteContext<"/api/markets/[action]">, guard) => {
  try {
    const parsed = parseMarketRequest((await params).action, await jsonBody(request));
    const record = await registeredMarket(parsed.req.mint, parsed.req.predictionId, parsed.action === "trade" ? parsed.req.wallet : undefined);
    if (!(await guard.spend(RPC_CALLS[parsed.action]))) return busy();
    switch (parsed.action) {
      case "odds":
        return ok(await getMarket(record, parsed.req.wallet, Date.now()));
      case "preview":
        return ok(await previewMarketTrade(record, parsed.req, Date.now()));
      case "trade":
        return ok(await buildMarketTradeForWallet(record, parsed.req, Date.now()));
      case "redeem":
        return ok(await buildMarketRedeemForWallet(record, parsed.req.wallet));
    }
  } catch (error) {
    return failOrBusy(error);
  }
});
