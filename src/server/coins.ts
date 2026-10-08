/** Read-side of the app: lists coins, one coin's detail, its recent trades, a wallet's holdings. */
import "server-only";
import type { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { type Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { CoinDetail, CoinView, Holdings, TapeItem, TradeView } from "@/lib/api-types";
import { loadConfig, type PoolView, toPoolView } from "@/lib/dbc/pool";
import { baseUnitsToCoins, lamportsToSol } from "@/lib/dbc/units";
import { shareInFlight } from "@/lib/in-flight";
import { isCanonicalTicker } from "@/lib/short-link";
import { buildTape } from "@/lib/tape";
import { streamLinkFromUri } from "@/lib/stream-link";
import { type PoolVaults, tradeFromTransaction } from "@/lib/trade-history";
import { getChain, poolForMint } from "./chain";
import { BusyError } from "./errors";
import { takeRpcBudget } from "./rpc-budget";
import { loadMetadata, MAX_ACCOUNTS_PER_CALL } from "./metadata";

async function withMetadata(connection: Connection, views: PoolView[]): Promise<CoinView[]> {
  const metadata = await loadMetadata(connection, views.map((v) => new PublicKey(v.mint)));
  return views.map((view, i) => {
    const meta = metadata[i];
    return {
      ...view,
      name: meta?.name ?? "Unnamed stream",
      symbol: meta?.symbol ?? "COIN",
      streamUrl: meta ? (streamLinkFromUri(meta.uri)?.url ?? null) : null,
    };
  });
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
  // Only tickers our launch could have written: on-chain launches with look-alike tickers are hidden.
  return (await withMetadata(connection, views)).filter((coin) => isCanonicalTicker(coin.symbol));
}

/** A scan: one program-account scan, the config, and one metadata call per 100 coins (last known count). */
const listScanCalls = () => 2 + Math.max(1, Math.ceil((listCache?.coins.length ?? 0) / MAX_ACCOUNTS_PER_CALL));

/**
 * Every coin launched on our config. `allowScan` is asked before a fresh scan (the RPC budget);
 * if it says no, the last good list is served.
 */
export async function listCoins(allowScan: () => Promise<boolean> = () => takeRpcBudget(listScanCalls())): Promise<CoinView[]> {
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
async function loadCoin(mint: string): Promise<{ coin: CoinView; vaults: PoolVaults } | null> {
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
 * the cache and the RPC budget live here, shared by all of them. The coin and its trades are cached
 * per coin, and a wallet's holdings separately, so made-up wallet addresses cost 2 calls, not a
 * full read. Unknown coins are remembered for 30 s so made-up addresses can't force reads; if
 * trade history briefly fails, the last good trades are kept.
 */
const DETAIL_CACHE_MS = 4_000;
const HOLDINGS_CACHE_MS = 2_000;
const MISS_CACHE_MS = 30_000;
/** A miss reads the pool, config, metadata and ~25 trades: roughly this many RPC calls. */
const COIN_RPC_CALLS = 24;
/** A wallet's SOL balance and its token account. */
const HOLDINGS_RPC_CALLS = 2;
/** Checking that the coin's pool exists first costs one call, so junk addresses can't drain the budget. */
const EXISTS_RPC_CALLS = 1;
const MAX_CACHED = 2_000;
type CoinAndTrades = Omit<CoinDetail, "holdings">;
const coinCache = new Map<string, { at: number; value: CoinAndTrades | null }>();
const holdingsCache = new Map<string, { at: number; value: Holdings | null }>();
/** Reads in progress: concurrent requests for the same coin (or holdings) share one read and one budget charge. */
const coinInFlight = new Map<string, Promise<CoinAndTrades | null>>();
const holdingsInFlight = new Map<string, Promise<Holdings | null>>();

/**
 * Coin, recent trades and (optionally) a wallet's holdings, or null if it isn't a memestream coin.
 * Throws BusyError when the RPC budget says no.
 */
export async function getCoinDetail(mint: string, wallet: string | null): Promise<CoinDetail | null> {
  const base = await coinAndTrades(mint);
  if (!base) return null;
  return { ...base, holdings: wallet ? await holdingsFor(mint, wallet) : null };
}

async function coinAndTrades(mint: string): Promise<CoinAndTrades | null> {
  const hit = coinCache.get(mint);
  if (hit && Date.now() - hit.at < (hit.value === null ? MISS_CACHE_MS : DETAIL_CACHE_MS)) return hit.value;
  return shareInFlight(coinInFlight, mint, () => refreshCoin(mint, hit?.value));
}

async function refreshCoin(mint: string, previous: CoinAndTrades | null | undefined): Promise<CoinAndTrades | null> {
  const now = Date.now();

  // Cheap existence check first (only when we don't already know the coin): unknown or made-up
  // addresses cost one call and are remembered as misses for 30 s.
  if (!previous) {
    const pool = poolForMint(mint);
    if (!pool) return remember(coinCache, mint, null, now);
    if (!(await takeRpcBudget(EXISTS_RPC_CALLS))) throw new BusyError();
    if (!(await getChain().connection.getAccountInfo(pool))) return remember(coinCache, mint, null, now);
  }
  if (!(await takeRpcBudget(COIN_RPC_CALLS - EXISTS_RPC_CALLS))) throw new BusyError();

  const fetched = await readCoinAndTrades(mint);
  const value = fetched && fetched.trades.length === 0 && previous?.trades.length ? { ...fetched, trades: previous.trades } : fetched;
  return remember(coinCache, mint, value, now);
}

async function holdingsFor(mint: string, wallet: string): Promise<Holdings | null> {
  const key = `${mint}|${wallet}`;
  const now = Date.now();
  const hit = holdingsCache.get(key);
  if (hit && now - hit.at < HOLDINGS_CACHE_MS) return hit.value;
  return shareInFlight(holdingsInFlight, key, async () => {
    if (!(await takeRpcBudget(HOLDINGS_RPC_CALLS))) throw new BusyError();
    return remember(holdingsCache, key, await walletHoldings(mint, wallet), Date.now());
  });
}

function remember<T>(cache: Map<string, { at: number; value: T }>, key: string, value: T, now: number): T {
  cache.set(key, { at: now, value });
  if (cache.size > MAX_CACHED) for (const [k, v] of cache) if (now - v.at > MISS_CACHE_MS) cache.delete(k);
  return value;
}

async function readCoinAndTrades(mint: string): Promise<CoinAndTrades | null> {
  const loaded = await loadCoin(mint);
  if (!loaded) return null;
  const { coin, vaults } = loaded;
  const trades = await recentTrades(getChain().client, coin, vaults).catch((error) => {
    console.warn("trade history unavailable:", (error as Error).message);
    return [];
  });
  return { coin, trades };
}

/** Our config's launch fee in SOL ("0" = free). The config is fixed on-chain, so it's read once. */
let launchFee: string | undefined;
export async function getLaunchFeeSol(): Promise<string | null> {
  if (launchFee !== undefined) return launchFee;
  if (!(await takeRpcBudget(1))) return null;
  const { client, config } = getChain();
  const read = await loadConfig(client, config).catch(() => null);
  if (!read) return null;
  launchFee = lamportsToSol(read.poolCreationFee);
  return launchFee;
}

/**
 * The ticker tape from what this server already has: the coin list (cached, budgeted) and the
 * trades coin pages have read. No extra RPC calls.
 */
export async function getTape(): Promise<TapeItem[]> {
  const coins = await listCoins();
  const tradesByMint = new Map<string, TradeView[]>();
  for (const [mint, entry] of coinCache) if (entry.value) tradesByMint.set(mint, entry.value.trades);
  return buildTape(coins, tradesByMint, Math.floor(Date.now() / 1000));
}

const TRADE_HISTORY_LIMIT = 25;

/** The pool's last few swaps (two RPC calls); other transactions on the pool are skipped. */
async function recentTrades(client: DynamicBondingCurveClient, coin: CoinView, vaults: PoolVaults): Promise<TradeView[]> {
  const signatures = await client.connection.getSignaturesForAddress(new PublicKey(coin.pool), { limit: TRADE_HISTORY_LIMIT });
  const transactions = await client.connection.getParsedTransactions(
    signatures.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0 },
  );
  return transactions.flatMap((tx, i) => tradeFromTransaction(tx, signatures[i].signature, { vaults, creator: coin.creator }) ?? []);
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
