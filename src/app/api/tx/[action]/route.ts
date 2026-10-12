import { type ParsedTx, parseTxRequest } from "@/server/requests";
import { buildMarketRedeemForWallet, buildMarketTradeForWallet } from "@/server/markets";
import { registeredMarket } from "@/server/predictions";
import { buildClaimForWallet, buildClaimPoolFeesForWallet, buildGraduateForWallet, buildLaunchForWallet, buildTradeForWallet } from "@/server/transactions";
import type { PreparedTx, TxAction } from "@/lib/api-types";
import { duplicateResponse, intentKey, intents } from "@/server/tx-intents";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, jsonBody, ok } from "../../respond";

/**
 * RPC calls each build makes (pool, config, blockhash, and more per action), charged after the
 * request parses so a bad request costs nothing. A trade is charged for the graduated path
 * (+ the Meteora pool and clock); claim-lp also reads the wallet's position NFTs and positions.
 */
const BUILD_RPC_CALLS: Record<TxAction, number> = { launch: 6, trade: 8, claim: 6, graduate: 6, "claim-lp": 10, market: 6, "market-redeem": 8 };

/** Builds the transaction for one parsed request. */
async function build(parsed: ParsedTx): Promise<PreparedTx> {
  switch (parsed.action) {
    case "launch":
      return buildLaunchForWallet(parsed.req);
    case "trade":
      return buildTradeForWallet(parsed.req);
    case "claim":
      return buildClaimForWallet(parsed.req);
    case "graduate":
      return buildGraduateForWallet(parsed.req);
    case "claim-lp":
      return buildClaimPoolFeesForWallet(parsed.req);
    // Markets: only registered ones (the oracle made them), so the lookup comes before the build.
    case "market":
      return buildMarketTradeForWallet(await registeredMarket(parsed.req.mint, parsed.req.predictionId, parsed.req.wallet), parsed.req, Date.now());
    case "market-redeem":
      return buildMarketRedeemForWallet(await registeredMarket(parsed.req.mint, parsed.req.predictionId), parsed.req.wallet);
  }
}

/**
 * An identical request from the same wallet whose earlier transaction is signed but not yet
 * confirmed, failed or expired answers 409 (tx-intents.ts). The answer carries `intent`, which the
 * client sends back on its status polls.
 */
export const POST = withRpcGuard({ name: "tx-build", burst: 10, perSecond: 1 }, async (request: Request, { params }: RouteContext<"/api/tx/[action]">, guard) => {
  try {
    const parsed = parseTxRequest((await params).action, await jsonBody(request));
    const key = intentKey(parsed);
    const pendingSignature = await intents().pending(key, Date.now());
    if (pendingSignature) return duplicateResponse(pendingSignature);
    if (!(await guard.spend(BUILD_RPC_CALLS[parsed.action]))) return busy();
    const prepared = await build(parsed);
    return ok({ ...prepared, intent: await intents().remember(key, prepared.blockhash, Date.now()) });
  } catch (error) {
    return failOrBusy(error);
  }
});
