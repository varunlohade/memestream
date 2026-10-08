import { getTape } from "@/server/coins";
import { withRpcGuard } from "@/server/rpc-guard";
import { failOrBusy, ok } from "../respond";

/** GET /api/tape -> { items }: the site's ticker tape, built from caches the app already has. */
export const GET = withRpcGuard({ name: "tape", burst: 20, perSecond: 2 }, async () => {
  try {
    return ok({ items: await getTape() });
  } catch (error) {
    return failOrBusy(error);
  }
});
