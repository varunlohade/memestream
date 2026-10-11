import { isBase58Of } from "@/lib/base58";
import { clientIp } from "@/server/rate-limit";
import { withRpcGuard } from "@/server/rpc-guard";
import { jsonBody, jsonError, ok } from "../../respond";
import { gate, predictionsError, signedInWallet } from "../respond";

/**
 * POST /api/predictions/heartbeat { mint } (session token) -> { accepted, points }.
 * Sent every 60 s while a coin page is visible: one minute watched on that coin, 2 free points
 * (600 a day at most). It counts only on a memestream coin that is trading or graduated; beats
 * closer than 50 s earn nothing, and only 5 wallets per IP a day earn. The server decides.
 */
export const POST = withRpcGuard({ name: "predictions-heartbeat", burst: 20, perSecond: 2 }, async (request: Request) => {
  const service = gate();
  if (service instanceof Response) return service;
  const wallet = signedInWallet(service, request);
  if (!wallet) return jsonError("Sign in to play", 401);
  try {
    const { mint } = await jsonBody(request);
    if (typeof mint !== "string" || !isBase58Of(mint, 32)) return jsonError("Not a valid coin address", 400);
    return ok(await service.beat(wallet, mint, clientIp(request)));
  } catch (error) {
    return predictionsError(error);
  }
});
