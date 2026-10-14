import { AdminSessionError, signedInAdmin } from "@/server/admin-session";
import { buildPartnerClaimsFor, CLAIM_RPC_CALLS, partnerFeesSummary, SUMMARY_RPC_CALLS } from "@/server/partner-fees";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, jsonError, ok } from "../../respond";

/** The signed-in admin's wallet (admin session token, /api/admin/session), or the refusal to send. */
function admin(request: Request): string | Response {
  try {
    return signedInAdmin(request, Date.now());
  } catch (error) {
    if (error instanceof AdminSessionError) return jsonError(error.message, error.status);
    throw error;
  }
}

/** GET /api/admin/fees (admin session) -> what memestream can claim on the config, and who can claim it. */
export const GET = withRpcGuard({ name: "admin-fees", burst: 5, perSecond: 1 }, async (request: Request, _context: unknown, guard) => {
  const wallet = admin(request);
  if (wallet instanceof Response) return wallet;
  if (!(await guard.spend(SUMMARY_RPC_CALLS))) return busy();
  try {
    return ok(await partnerFeesSummary(wallet));
  } catch (error) {
    return failOrBusy(error);
  }
});

/** POST /api/admin/fees (admin session, as the fee claimer) -> unsigned claim transactions for that wallet to sign. */
export const POST = withRpcGuard({ name: "admin-fees-claim", burst: 3, perSecond: 1 }, async (request: Request, _context: unknown, guard) => {
  const wallet = admin(request);
  if (wallet instanceof Response) return wallet;
  if (!(await guard.spend(CLAIM_RPC_CALLS))) return busy();
  try {
    return ok(await buildPartnerClaimsFor(wallet));
  } catch (error) {
    return failOrBusy(error);
  }
});
