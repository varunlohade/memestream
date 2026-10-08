/** Read-side of the app: lists coins, one coin's detail, its recent trades, a wallet's holdings. */
import "server-only";
import type { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { type Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { CoinDetail, CoinView, Holdings, TradeView } from "@/lib/api-types";
import { loadConfig, type PoolView, toPoolView } from "@/lib/dbc/pool";
import { baseUnitsToCoins, lamportsToSol } from "@/lib/dbc/units";
import { streamLinkFromUri } from "@/lib/stream-link";
import { getChain, poolForMint } from "./chain";
import { BusyError } from "./errors";
import { takeRpcBudget } from "./rpc-budget";
import { loadMetadata } from "./metadata";

async function withMetadata(connection: Connection, views: PoolView[]): Promise<CoinView[]> {
  const metadata = await loadMetadata(connection, views.map((v) => new PublicKey(v.mint)));
  return views.map((view, i) => ({
    ...view,
    name: metadata[i]?.name ?? "Unnamed stream",
    symbol: metadata[i]?.symbol ?? "COIN",
    streamUrl: metadata[i] ? (streamLinkFromUri(metadata[i].uri)?.url ?? null) : null,
  }));
}

/**
 * Listing scans every DBC account for our config (getProgramAccounts), which public RPCs
 * rate-limit. So one scan serves everyone for a few seconds, and on failure we serve the
 * last good list. Mainnet needs an indexer or a paid RPC instead.
 */
const LIST_TTL_MS = 8_000;
let listCache: { at: number; coins: CoinView[] } | null = null;
let listInFlight: Promise<CoinView[]> | null = null;

async function scanCoins(): Promise<CoinView[]> {
  const { client, connection, config } = getChain();
  const [pools, poolConfig] = await Promise.all([client.state.getPoolsByConfig(config), loadConfig(client, config)]);
  // The scan already returns each pool's state, so build views from it: no per-pool refetch.
  const views = pools.map((p) => toPoolView({ address: p.publicKey, pool: p.account, config: poolConfig }));
  return withMetadata(connection, views);
}

/**
 * Every coin launched on our config. `allowScan` is asked before a fresh scan (the RPC budget);
 * if it says no, the last good list is served.
 */
/** A scan: one program-account scan, the config, and one metadata batch. */
const LIST_SCAN_CALLS = 3;

export async function listCoins(allowScan: () => Promise<boolean> = () => takeRpcBudget(LIST_SCAN_CALLS)): Promise<CoinView[]> {
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.coins;
  // Set synchronously, so concurrent callers share one budget check and one scan.
  listInFlight ??= refreshList(allowScan).finally(() => {
    listInFlight = null;
  });
  return listInFlight;
}

async function refreshList(allowScan: () => Promise<boolean>): Promise<CoinView[]> {
  if (!(await allowScan())) {
    if (listCache) return listCache.coins;
    throw new BusyError();
  }
  try {
    const coins = await scanCoins();
    listCache = { at: Date.now(), coins };
    return coins;
  } catch (error) {
    if (listCache) {
      console.warn("coin scan failed; serving the last good list:", (error as Error).message);
      return listCache.coins;
    }
    throw error;
  }
}

/** A coin's view plus the vault addresses its trade history needs. */
async function loadCoin(mint: string): Promise<{ coin: CoinView; vaults: { quote: PublicKey; base: PublicKey } } | null> {
  const { client, connection } = getChain();
  const address = poolForMint(mint);
  const pool = address && (await client.state.getPool(address));
  if (!address || !pool) return null;
  const config = await loadConfig(client, pool.poolState.config);
  const [coin] = await withMetadata(connection, [toPoolView({ address, pool, config })]);
  return { coin, vaults: { quote: pool.poolState.quoteVault, base: pool.poolState.baseVault } };
}

/**
 * Coin detail is read by the API route AND by server-rendered pages (coin page, OBS overlay), so
 * the cache and the RPC budget live here, shared by all of them. Many viewers cost about the same
 * RPC as one; unknown coins are remembered for 30 s so made-up addresses can't force reads; if
 * trade history briefly fails, the last good trades are kept.
 */
const DETAIL_CACHE_MS = 4_000;
const WALLET_DETAIL_CACHE_MS = 2_000;
const MISS_CACHE_MS = 30_000;
/** A miss reads the pool, config, metadata, ~25 trades and holdings: roughly this many RPC calls. */
const DETAIL_RPC_CALLS = 26;
/** Checking that the coin's pool exists first costs one call, so junk addresses can't drain the budget. */
const EXISTS_RPC_CALLS = 1;
const detailCache = new Map<string, { at: number; detail: CoinDetail | null }>();

/**
 * Coin, recent trades and (optionally) a wallet's holdings, or null if it isn't a memestream coin.
 * Throws BusyError when the RPC budget says no.
 */
export async function getCoinDetail(mint: string, wallet: string | null): Promise<CoinDetail | null> {
  const key = `${mint}|${wallet ?? ""}`;
  const now = Date.now();
  const hit = detailCache.get(key);
  const ttl = hit?.detail === null ? MISS_CACHE_MS : wallet ? WALLET_DETAIL_CACHE_MS : DETAIL_CACHE_MS;
  if (hit && now - hit.at < ttl) return hit.detail;

  // Cheap existence check first (only when we don't already know the coin): unknown or made-up
  // addresses cost one call and are remembered as misses for 30 s.
  if (!hit?.detail) {
    const pool = poolForMint(mint);
    if (!pool) return remember(key, null, now);
    if (!(await takeRpcBudget(EXISTS_RPC_CALLS))) throw new BusyError();
    if (!(await getChain().connection.getAccountInfo(pool))) return remember(key, null, now);
  }
  if (!(await takeRpcBudget(DETAIL_RPC_CALLS - EXISTS_RPC_CALLS))) throw new BusyError();

  const fetched = await readCoinDetail(mint, wallet);
  const previous = hit?.detail;
  const detail =
    fetched && fetched.trades.length === 0 && previous?.trades.length ? { ...fetched, trades: previous.trades } : fetched;
  return remember(key, detail, now);
}

function remember(key: string, detail: CoinDetail | null, now: number): CoinDetail | null {
  detailCache.set(key, { at: now, detail });
  if (detailCache.size > 2_000) for (const [k, v] of detailCache) if (now - v.at > MISS_CACHE_MS) detailCache.delete(k);
  return detail;
}

async function readCoinDetail(mint: string, wallet: string | null): Promise<CoinDetail | null> {
  const loaded = await loadCoin(mint);
  if (!loaded) return null;
  const { coin, vaults } = loaded;
  const [trades, holdings] = await Promise.all([
    recentTrades(getChain().client, coin, vaults).catch((error) => {
      console.warn("trade history unavailable:", (error as Error).message);
      return [];
    }),
    wallet ? walletHoldings(mint, wallet) : null,
  ]);
  return { coin, trades, holdings };
}

const TRADE_HISTORY_LIMIT = 25;

type TokenBalances = { accountIndex: number; uiTokenAmount: { amount: string } }[] | null | undefined;
const vaultAmount = (balances: TokenBalances, index: number) =>
  new BN(balances?.find((b) => b.accountIndex === index)?.uiTokenAmount.amount ?? "0");

/**
 * Recent swaps, read from the pool's vault balance changes: SOL into the quote vault is a buy.
 * Launch, claim and graduation transactions don't move both vaults and are skipped.
 */
async function recentTrades(
  client: DynamicBondingCurveClient,
  coin: CoinView,
  vaults: { quote: PublicKey; base: PublicKey },
): Promise<TradeView[]> {
  const signatures = await client.connection.getSignaturesForAddress(new PublicKey(coin.pool), { limit: TRADE_HISTORY_LIMIT });
  const transactions = await client.connection.getParsedTransactions(
    signatures.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0 },
  );

  const trades: TradeView[] = [];
  transactions.forEach((tx, i) => {
    if (!tx?.meta || tx.meta.err) return;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const quoteIndex = keys.indexOf(vaults.quote.toBase58());
    const baseIndex = keys.indexOf(vaults.base.toBase58());
    if (quoteIndex < 0 || baseIndex < 0) return;
    const quoteDelta = vaultAmount(tx.meta.postTokenBalances, quoteIndex).sub(vaultAmount(tx.meta.preTokenBalances, quoteIndex));
    const baseDelta = vaultAmount(tx.meta.postTokenBalances, baseIndex).sub(vaultAmount(tx.meta.preTokenBalances, baseIndex));
    if (quoteDelta.isZero() || baseDelta.isZero()) return;

    const sol = lamportsToSol(quoteDelta.abs());
    const coins = baseUnitsToCoins(baseDelta.abs());
    const wallet = keys[0];
    trades.push({
      signature: signatures[i].signature,
      side: quoteDelta.gtn(0) ? "buy" : "sell",
      sol,
      coins,
      wallet,
      time: tx.blockTime ?? null,
      priceSol: Number(sol) / Number(coins),
      byStreamer: wallet === coin.creator,
    });
  });
  return trades;
}

/** A wallet's SOL and its balance of one coin (0 if it has no token account yet). */
async function walletHoldings(mint: string, wallet: string): Promise<Holdings | null> {
  let owner: PublicKey;
  let mintKey: PublicKey;
  try {
    owner = new PublicKey(wallet);
    mintKey = new PublicKey(mint);
  } catch {
    return null;
  }
  const { connection } = getChain();
  const [lamports, tokens] = await Promise.all([
    connection.getBalance(owner),
    connection
      .getTokenAccountBalance(getAssociatedTokenAddressSync(mintKey, owner))
      .then((r) => r.value.amount)
      .catch(() => "0"),
  ]);
  return { sol: lamportsToSol(new BN(lamports)), coins: baseUnitsToCoins(new BN(tokens)) };
}
