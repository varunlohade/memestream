import { withRpcGuard } from "@/server/rpc-guard";
import { jsonError, ok } from "../../respond";
import { gate, predictionsError, signedInWallet } from "../respond";

/**
 * POST /api/predictions/heartbeat (session token) -> { accepted, points }.
 * Sent every 60 s while a coin page is visible: one minute watched, 2 free points (600 a day at
 * most). Beats closer than 50 s earn nothing; the server decides, not the browser.
 */
export const POST = withRpcGuard({ name: "predictions-heartbeat", burst: 20, perSecond: 2 }, async (request: Request) => {
  const service = gate();
  if (service instanceof Response) return service;
  const wallet = signedInWallet(service, request);
  if (!wallet) return jsonError("Sign in to play", 401);
  try {
    return ok(await service.beat(wallet));
  } catch (error) {
    return predictionsError(error);
  }
});
