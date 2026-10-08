import { coinForTicker, parseTicker } from "@/lib/short-link";
import { listCoins } from "@/server/coins";
import { withRpcGuard } from "@/server/rpc-guard";

/**
 * memestream.lol/<ticker> (the link on the OBS overlay) → a real 307 to that coin's page.
 * Not a ticker (robots.txt, typos with dots) → 404. A ticker with no coin yet, or busy → home.
 * The cached coin list draws the RPC budget once per scan for everyone.
 * The Location is relative, so the request's Host header is never trusted.
 */
export const GET = withRpcGuard({ name: "ticker", burst: 30, perSecond: 3 }, async (_request, { params }: RouteContext<"/[ticker]">) => {
  const { ticker } = await params;
  if (!parseTicker(ticker)) return new Response("Not found", { status: 404 });
  const coin = coinForTicker(await listCoins().catch(() => []), ticker);
  return new Response(null, { status: 307, headers: { Location: coin ? `/coin/${coin.mint}` : "/" } });
});
