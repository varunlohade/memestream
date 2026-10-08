import { coinForTicker } from "@/lib/short-link";
import { listCoins } from "@/server/coins";
import { withRpcGuard } from "@/server/rpc-guard";

/**
 * memestream.lol/<ticker> (the link on the OBS overlay) → a real 307 to that coin's page.
 * The cached coin list draws the RPC budget once per scan for everyone. Unknown ticker, or busy → home.
 * The Location is relative, so the request's Host header is never trusted.
 */
export const GET = withRpcGuard({ burst: 30, perSecond: 3 }, async (_request, { params }: RouteContext<"/[ticker]">) => {
  const coin = coinForTicker(await listCoins().catch(() => []), (await params).ticker);
  return new Response(null, { status: 307, headers: { Location: coin ? `/coin/${coin.mint}` : "/" } });
});
