import { listPublicCoins } from "@/server/coins";
import { withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, ok } from "../respond";

/** The list is cached server-side (one scan per 8 s for everyone); listPublicCoins draws the RPC budget per scan. */
export const GET = withRpcGuard({ name: "coins", burst: 30, perSecond: 3 }, async () => {
  try {
    return ok({ coins: await listPublicCoins() });
  } catch (error) {
    return failOrBusy(error);
  }
});
