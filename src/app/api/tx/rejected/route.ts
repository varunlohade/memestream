import { UserError } from "@/server/errors";
import { withRpcGuard } from "@/server/rpc-guard";
import { intents, isIntentToken } from "@/server/tx-intents";
import { fail, jsonError, ok } from "../../respond";

const PUBLIC_URL = (process.env.MEMESTREAM_PUBLIC_URL ?? "").replace(/\/$/, "");

/**
 * POST /api/tx/rejected?intent= : the wallet rejected this build, or failed before sending it
 * (walletFailure in lib/tx-flow.ts), so the double-pay hold on it is dropped and the same trade can be
 * built again at once. Only the matching, still unsigned intent
 * is dropped (tx-intents.ts release); the token is unguessable and names one wallet's intent.
 * No RPC calls; the per-client limit bounds abuse.
 */
export const POST = withRpcGuard({ name: "tx-rejected", burst: 10, perSecond: 1 }, async (request: Request) => {
  const origin = request.headers.get("origin");
  if (origin !== null && origin.replace(/\/$/, "") !== PUBLIC_URL) return jsonError("Forbidden", 403);
  try {
    const intent = new URL(request.url).searchParams.get("intent") ?? "";
    if (!isIntentToken(intent)) throw new UserError("Not a valid intent");
    await intents().release(intent);
    return ok({ released: true });
  } catch (error) {
    return fail(error);
  }
});
