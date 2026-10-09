import { withRpcGuard } from "@/server/rpc-guard";
import { jsonBody, jsonError, ok } from "../../respond";
import { gate, predictionsError } from "../respond";

/**
 * POST /api/predictions/session { message, signature } -> { wallet, token, expiresAt }.
 * The wallet signed one message (nonce + expiry); later calls send the token instead.
 * Free points only: signing costs nothing and sends nothing.
 */
export const POST = withRpcGuard({ name: "predictions-session", burst: 5, perSecond: 1 }, async (request: Request) => {
  const service = gate();
  if (service instanceof Response) return service;
  try {
    const { message, signature } = await jsonBody(request);
    if (typeof message !== "string" || typeof signature !== "string" || message.length > 1_000 || signature.length > 200) {
      return jsonError("Sign the message to play", 400);
    }
    return ok(await service.session(message, signature));
  } catch (error) {
    return predictionsError(error);
  }
});
