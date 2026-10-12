import { parseQuote } from "@/server/requests";
import { withRpcGuard } from "@/server/rpc-guard";
import { previewTrade } from "@/server/transactions";
import { fail, ok } from "../respond";

/** GET /api/quote?mint=&side=buy|sell&amount=&slippageBps= (debounced as you type; ~4 RPC calls each). */
export const GET = withRpcGuard({ name: "quote", burst: 20, perSecond: 2, calls: 4 }, async (request: Request) => {
  try {
    return ok(await previewTrade(parseQuote(new URL(request.url).searchParams)));
  } catch (error) {
    return fail(error);
  }
});
