/** Token metadata JSON that wallets and explorers fetch from a coin's on-chain URI. */
import { PublicKey } from "@solana/web3.js";
import { parseStreamLink } from "@/lib/stream-link";
import { getChain } from "@/server/chain";
import { loadMetadata, type TokenMetadata } from "@/server/metadata";
import { busy, withRpcGuard } from "@/server/rpc-guard";

/** Name and symbol never change on-chain, so one read per coin serves everyone for a while. */
const NAME_CACHE_MS = 5 * 60_000;
const names = new Map<string, { at: number; meta: TokenMetadata | null }>();

export const GET = withRpcGuard({ burst: 30, perSecond: 3 }, async (request: Request, { params }: { params: Promise<{ mint: string }> }, guard) => {
  const { mint } = await params;
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return Response.json({ error: "Not a valid coin address" }, { status: 404 });
  }

  const now = Date.now();
  let cached = names.get(mint);
  if (!cached || now - cached.at > NAME_CACHE_MS) {
    if (!guard.spend(1)) return busy();
    const [meta] = await loadMetadata(getChain().connection, [mintKey]).catch(() => [null]);
    cached = { at: now, meta };
    names.set(mint, cached);
    if (names.size > 5_000) for (const [k, v] of names) if (now - v.at > NAME_CACHE_MS) names.delete(k);
  }

  // Only a valid Twitch/YouTube/Kick link is echoed; anything else is ignored (it can't vary the cache).
  const link = parseStreamLink(new URL(request.url).searchParams.get("link") ?? "");
  return Response.json(
    {
      name: cached.meta?.name ?? "memestream coin",
      symbol: cached.meta?.symbol ?? "",
      description: "A memestream coin for a live stream. 80% of fees go to the streamer.",
      external_url: `${getChain().publicUrl}/coin/${mint}`,
      ...(link ? { properties: { stream: link.url } } : {}),
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
});
