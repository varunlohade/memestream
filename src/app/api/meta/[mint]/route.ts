/** Token metadata JSON that wallets and explorers fetch from a coin's on-chain URI. */
import { PublicKey } from "@solana/web3.js";
import { streamLinkFromUri } from "@/lib/stream-link";
import { getChain, poolForMint } from "@/server/chain";
import { loadCoinMetadata, type TokenMetadata } from "@/server/metadata";
import { busy, withRpcGuard } from "@/server/rpc-guard";
import { jsonError } from "../../respond";

/** Name and symbol never change on-chain, so one read per coin serves everyone for a while. */
const NAME_CACHE_MS = 5 * 60_000;
/** A miss (not ours, or a failed read) is retried sooner, so a brand-new coin isn't hidden long. */
const MISS_CACHE_MS = 30_000;
/** Past this many entries, old ones are dropped on the next read. */
const MAX_CACHED = 5_000;
const metadataCache = new Map<string, { at: number; meta: TokenMetadata | null }>();

export const GET = withRpcGuard({ name: "meta", burst: 30, perSecond: 3 }, async (_request: Request, { params }: RouteContext<"/api/meta/[mint]">, guard) => {
  const { mint } = await params;
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return jsonError("Not a valid coin address", 404);
  }
  const pool = poolForMint(mint);
  if (!pool) return jsonError("Not a memestream coin", 404);

  const now = Date.now();
  let cached = metadataCache.get(mint);
  if (!cached || now - cached.at > (cached.meta ? NAME_CACHE_MS : MISS_CACHE_MS)) {
    if (!(await guard.spend(1))) return busy();
    const meta = await loadCoinMetadata(getChain().connection, mintKey, pool).catch(() => null);
    cached = { at: now, meta };
    metadataCache.set(mint, cached);
    if (metadataCache.size > MAX_CACHED) for (const [k, v] of metadataCache) if (now - v.at > NAME_CACHE_MS) metadataCache.delete(k);
  }

  // Not on our config (or the read failed): never describe it as a memestream coin.
  if (!cached.meta) return jsonError("Not a memestream coin", 404);

  // The stream link comes from this coin's own on-chain URI, never from the request: another token
  // pointing its URI here can't make us vouch for a stream of its choosing.
  const link = streamLinkFromUri(cached.meta.uri);
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
