/** Token metadata JSON that wallets and explorers fetch from a coin's on-chain URI. */
import { PublicKey } from "@solana/web3.js";
import { parseStreamLink } from "@/lib/stream-link";
import { getChain, poolForMint } from "@/server/chain";
import { loadCoinMetadata, type TokenMetadata } from "@/server/metadata";
import { busy, withRpcGuard } from "@/server/rpc-guard";

/** Name and symbol never change on-chain, so one read per coin serves everyone for a while. */
const NAME_CACHE_MS = 5 * 60_000;
/** A miss (not ours, or a failed read) is retried sooner, so a brand-new coin isn't hidden long. */
const MISS_CACHE_MS = 30_000;
const names = new Map<string, { at: number; meta: TokenMetadata | null }>();

export const GET = withRpcGuard({ name: "meta", burst: 30, perSecond: 3 }, async (request: Request, { params }: { params: Promise<{ mint: string }> }, guard) => {
  const { mint } = await params;
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return Response.json({ error: "Not a valid coin address" }, { status: 404 });
  }
  const pool = poolForMint(mint);
  if (!pool) return Response.json({ error: "Not a memestream coin" }, { status: 404 });

  const now = Date.now();
  let cached = names.get(mint);
  if (!cached || now - cached.at > (cached.meta ? NAME_CACHE_MS : MISS_CACHE_MS)) {
    if (!(await guard.spend(1))) return busy();
    const meta = await loadCoinMetadata(getChain().connection, mintKey, pool).catch(() => null);
    cached = { at: now, meta };
    names.set(mint, cached);
    if (names.size > 5_000) for (const [k, v] of names) if (now - v.at > NAME_CACHE_MS) names.delete(k);
  }

  // Not on our config (or the read failed): never describe it as a memestream coin.
  if (!cached.meta) return Response.json({ error: "Not a memestream coin" }, { status: 404 });

  // Only a valid Twitch/YouTube/Kick link is echoed; anything else is ignored (it can't vary the cache).
  const link = parseStreamLink(new URL(request.url).searchParams.get("link") ?? "");
  return Response.json(
    {
      name: cached.meta.name,
      symbol: cached.meta.symbol,
      description: "A memestream coin for a live stream. 80% of fees go to the streamer.",
      external_url: `${getChain().publicUrl}/coin/${mint}`,
      ...(link ? { properties: { stream: link.url } } : {}),
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
});
