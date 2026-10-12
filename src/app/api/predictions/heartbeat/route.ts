import { isBase58Of } from "@/lib/base58";
import { withRpcGuard } from "@/server/rpc-guard";
import { jsonBody, jsonError, ok } from "../../respond";
import { gate, predictionsError, signedInWallet } from "../respond";

/**
 * POST /api/predictions/heartbeat { mint } (session token) -> { accepted }.
 * Sent every 60 s by the streamer's own coin page: it marks them "here" (the crowd's questions go
 * live only then). Anyone else's beat does nothing; nobody earns points from it.
 */
export const POST = withRpcGuard({ name: "predictions-heartbeat", burst: 20, perSecond: 2 }, async (request: Request) => {
  const service = gate();
  if (service instanceof Response) return service;
  const wallet = signedInWallet(service, request);
  if (!wallet) return jsonError("Sign in to play", 401);
  try {
    const { mint } = await jsonBody(request);
    if (typeof mint !== "string" || !isBase58Of(mint, 32)) return jsonError("Not a valid coin address", 400);
    return ok(await service.beat(wallet, mint));
  } catch (error) {
    return predictionsError(error);
  }
});
