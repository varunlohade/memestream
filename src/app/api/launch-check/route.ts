import { isBase58Of } from "@/lib/base58";
import { parseStreamLink } from "@/lib/stream-link";
import { UserError } from "@/server/errors";
import { checkLaunch, inviteSettings } from "@/server/invites";
import { withRpcGuard } from "@/server/rpc-guard";
import { fail, jsonBody, ok } from "../respond";

/**
 * POST /api/launch-check { wallet, streamUrl? } -> LaunchCheck: is this wallet invited, and is the
 * stream live on its own channel. At most one YouTube call (none for a wallet that isn't invited),
 * no RPC calls; the per-client limit protects the YouTube quota.
 */
export const POST = withRpcGuard({ name: "launch-check", burst: 5, perSecond: 1 }, async (request: Request) => {
  try {
    const body = await jsonBody(request);
    const wallet = typeof body.wallet === "string" ? body.wallet : "";
    if (!isBase58Of(wallet, 32)) throw new UserError("Not a valid wallet address");
    const link = parseStreamLink(typeof body.streamUrl === "string" ? body.streamUrl : "");
    return ok(await checkLaunch(inviteSettings(), wallet, link?.platform === "youtube" ? link : null));
  } catch (error) {
    return fail(error);
  }
});
