import { withRpcGuard } from "@/server/rpc-guard";
import { jsonBody, jsonError, ok } from "../../respond";
import { gate, predictionsError } from "../respond";

/** Generous bounds: a session message is about 300 characters, a base58 signature about 88. */
const MAX_MESSAGE_CHARS = 1_000;
const MAX_SIGNATURE_CHARS = 200;

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
    if (typeof message !== "string" || typeof signature !== "string" || message.length > MAX_MESSAGE_CHARS || signature.length > MAX_SIGNATURE_CHARS) {
      return jsonError("Sign the message to play", 400);
    }
    return ok(await service.session(message, signature));
  } catch (error) {
    return predictionsError(error);
  }
});
