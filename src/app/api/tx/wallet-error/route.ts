import { UserError } from "@/server/errors";
import { withRpcGuard } from "@/server/rpc-guard";
import { intents, isIntentToken } from "@/server/tx-intents";
import { fail, jsonError, ok } from "../../respond";

const PUBLIC_URL = (process.env.MEMESTREAM_PUBLIC_URL ?? "").replace(/\/$/, "");

/**
 * POST /api/tx/wallet-error?intent= : the wallet failed with an error that wasn't a rejection, so it
 * may have sent this build without reporting a signature. The double-pay hold on it is kept as if it
 * were signed (tx-intents.ts maybeSent). Only an intent this server built can be held; the token is
 * unguessable and names one wallet's intent. No RPC calls; the per-client limit bounds abuse.
 */
export const POST = withRpcGuard({ name: "tx-wallet-error", burst: 10, perSecond: 1 }, async (request: Request) => {
  const origin = request.headers.get("origin");
  if (origin !== null && origin.replace(/\/$/, "") !== PUBLIC_URL) return jsonError("Forbidden", 403);
  try {
    const intent = new URL(request.url).searchParams.get("intent") ?? "";
    if (!isIntentToken(intent)) throw new UserError("Not a valid intent");
    await intents().maybeSent(intent, Date.now());
    return ok({ held: true });
  } catch (error) {
    return fail(error);
  }
});
