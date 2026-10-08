import { parseTxRequest } from "@/server/requests";
import { buildClaimForWallet, buildClaimPoolFeesForWallet, buildGraduateForWallet, buildLaunchForWallet, buildTradeForWallet } from "@/server/transactions";
import { withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, jsonBody, ok } from "../../respond";

/** Building a transaction reads the pool, config and a blockhash: ~6 RPC calls. */
export const POST = withRpcGuard({ name: "tx-build", burst: 10, perSecond: 1, calls: 6 }, async (request: Request, { params }: RouteContext<"/api/tx/[action]">) => {
  try {
    const parsed = parseTxRequest((await params).action, await jsonBody(request));
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
