import { parseTxRequest } from "@/server/requests";
import { buildClaimForWallet, buildClaimPoolFeesForWallet, buildGraduateForWallet, buildLaunchForWallet, buildTradeForWallet } from "@/server/transactions";
import type { TxAction } from "@/lib/api-types";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, jsonBody, ok } from "../../respond";

/**
 * RPC calls each build makes (pool, config, blockhash, and more per action), charged after the
 * request parses so a bad request costs nothing. A trade is charged for the graduated path
 * (+ the Meteora pool and clock); claim-lp also reads the wallet's position NFTs and positions.
 */
const BUILD_RPC_CALLS: Record<TxAction, number> = { launch: 6, trade: 8, claim: 6, graduate: 6, "claim-lp": 10 };

export const POST = withRpcGuard({ name: "tx-build", burst: 10, perSecond: 1 }, async (request: Request, { params }: RouteContext<"/api/tx/[action]">, guard) => {
  try {
    const parsed = parseTxRequest((await params).action, await jsonBody(request));
    if (!(await guard.spend(BUILD_RPC_CALLS[parsed.action]))) return busy();
    switch (parsed.action) {
      case "launch":
        return ok(await buildLaunchForWallet(parsed.req));
      case "trade":
        return ok(await buildTradeForWallet(parsed.req));
      case "claim":
        return ok(await buildClaimForWallet(parsed.req));
      case "graduate":
        return ok(await buildGraduateForWallet(parsed.req));
      case "claim-lp":
        return ok(await buildClaimPoolFeesForWallet(parsed.req));
    }
  } catch (error) {
    return failOrBusy(error);
  }
});
