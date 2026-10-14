import { AdminSessionError, adminSession } from "@/server/admin-session";
import { withRpcGuard } from "@/server/rpc-guard";
import { jsonBody, jsonError, ok } from "../../respond";

const MAX_MESSAGE_CHARS = 1_000;
const MAX_SIGNATURE_CHARS = 200;

/** POST /api/admin/session { message, signature } -> { wallet, token, expiresAt }, for admin wallets only. No RPC calls. */
export const POST = withRpcGuard({ name: "admin-session", burst: 5, perSecond: 1 }, async (request: Request) => {
  const { message, signature } = await jsonBody(request);
  if (typeof message !== "string" || typeof signature !== "string" || message.length > MAX_MESSAGE_CHARS || signature.length > MAX_SIGNATURE_CHARS) {
    return jsonError("Sign the message to continue", 400);
  }
  try {
    return ok(adminSession(message, signature, Date.now()));
  } catch (error) {
    if (error instanceof AdminSessionError) return jsonError(error.message, error.status);
    throw error;
  }
});
