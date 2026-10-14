/** Read-side of the app: lists coins, one coin's detail, its recent trades, a wallet's holdings. */
import "server-only";
import { deriveDammV2PoolAuthority, deriveDbcPoolAuthority, type DynamicBondingCurveClient, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { type Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { CoinDetail, CoinView, HolderView, Holdings, TapeItem, TradeView } from "@/lib/api-types";
import { loadConfig, type PoolView, toPoolView } from "@/lib/dbc/pool";
import { fetchDammPools, graduatedPoolAddress, isCoinSolPool, withGraduatedPool } from "@/lib/damm/pool";
import { mintSupply, OWNER_AMOUNT_SLICE, slicedOwnerAmount, tokenAccountOwner, toHolders } from "@/lib/holders";
import { lpPositionsOf, unclaimedPoolFees } from "@/lib/damm/positions";
import { baseUnitsToCoins, lamportsToSol } from "@/lib/dbc/units";
import { shareInFlight } from "@/lib/in-flight";
import { isCanonicalTicker } from "@/lib/short-link";
import { hiddenCreators, hiddenMints, withoutHiddenCreators } from "@/lib/hidden-coins";
import { buildTape } from "@/lib/tape";
import { streamLinkFromUri } from "@/lib/stream-link";
import { type PoolVaults, tradeFromTransaction } from "@/lib/trade-history";
import { getChain, poolForMint } from "./chain";
import { BusyError } from "./errors";
import { chargeRpcBudget, takeRpcBudget } from "./rpc-budget";
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
  const views = await withGraduatedPrices(
    connection,
    poolConfig,
    pools.map((p) => toPoolView({ address: p.publicKey, pool: p.account, config: poolConfig })),
  );
  // Only tickers our launch could have written: on-chain launches with look-alike tickers are hidden.
  return (await withMetadata(connection, views)).filter((coin) => isCanonicalTicker(coin.symbol));
}

/**
 * A scan: one program-account scan, the config, one metadata call per 100 coins, and one Meteora
 * pool read per 100 graduated coins (from the last known list).
 */
const listScanCalls = () => {
  const coins = listCache?.coins ?? [];
  const graduated = coins.filter((c) => c.status === "graduated").length;
  return 2 + Math.max(1, Math.ceil(coins.length / MAX_ACCOUNTS_PER_CALL)) + Math.ceil(graduated / MAX_ACCOUNTS_PER_CALL);
};

/** Graduated coins get their live Meteora price (their curve froze at graduation): one read per 100. */
async function withGraduatedPrices(connection: Connection, config: PoolConfig, views: PoolView[]): Promise<PoolView[]> {
  const graduated = views.filter((v) => v.status === "graduated");
  if (graduated.length === 0) return views;
  const addresses = graduated.map((v) => graduatedPoolAddress(config, new PublicKey(v.mint)));
  const states = await fetchDammPools(connection, addresses);
  const supply = Number(baseUnitsToCoins(config.preMigrationTokenSupply));
  const priced = new Map(graduated.map((v, i) => [v.mint, withGraduatedPool(v, addresses[i], states[i], supply)]));
  return views.map((v) => priced.get(v.mint) ?? v);
}

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

/**
 * The coins the public lists show (home, tape, /api/coins): listCoins minus our own test coins,
 * whose creators are in MEMESTREAM_HIDDEN_CREATORS. Same cache and budget; direct links still use listCoins.
 */
export async function listPublicCoins(): Promise<CoinView[]> {
  return withoutHiddenCreators(await listCoins(), hiddenCreators(process.env.MEMESTREAM_HIDDEN_CREATORS), hiddenMints(process.env.MEMESTREAM_HIDDEN_MINTS));
}

/** A coin's view plus the vault addresses its trade history needs. */
/** Where a coin's trades happen: its curve, or after graduation its Meteora pool. */
type TradeVenue = { address: PublicKey; vaults: PoolVaults };

async function loadCoin(mint: string): Promise<{ coin: CoinView; venue: TradeVenue } | null> {
  const { client, connection } = getChain();
  const address = poolForMint(mint);
  const pool = address && (await client.state.getPool(address));
  if (!address || !pool) return null;
  const config = await loadConfig(client, pool.poolState.config);
  let view = toPoolView({ address, pool, config });
  let venue: TradeVenue = { address, vaults: { quote: pool.poolState.quoteVault, base: pool.poolState.baseVault } };
  if (view.status === "graduated") {
    // Live price and trades come from the Meteora pool; the curve froze at graduation.
    const damm = graduatedPoolAddress(config, pool.poolState.baseMint);
    const [fetched] = await fetchDammPools(connection, [damm]);
    const state = fetched && isCoinSolPool(fetched, pool.poolState.baseMint) ? fetched : null; // same check as trading
    view = withGraduatedPool(view, damm, state, Number(baseUnitsToCoins(config.preMigrationTokenSupply)));
    if (state) venue = { address: damm, vaults: { quote: state.tokenBVault, base: state.tokenAVault } };
  }
  const [coin] = await withMetadata(connection, [view]);
  return { coin, venue };
}

/**
 * Coin detail is read by the API route AND by server-rendered pages (coin page, OBS overlay), so
 * the cache and the RPC budget live here, shared by all of them. The coin and its trades are cached
 * per coin, and a wallet's holdings separately, so made-up wallet addresses cost 2 calls, not a
 * full read. Unknown coins (no pool account on our config) are remembered for 30 s so made-up
 * addresses can't force reads; a known coin whose read fails keeps its last good data, and if
 * trade history briefly fails, the last good trades are kept.
 */
const DETAIL_CACHE_MS = 4_000;
const HOLDINGS_CACHE_MS = 2_000;
const MISS_CACHE_MS = 30_000;
/** A miss reads the pool, config, metadata, the Meteora pool once graduated, and ~25 trades: roughly this many RPC calls. */
const COIN_RPC_CALLS = 25;
/** A wallet's SOL balance and its token account. */
const HOLDINGS_RPC_CALLS = 2;
/** For a graduated coin: the wallet's position NFTs, their positions, and the pool. */
const LP_FEES_RPC_CALLS = 3;
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
 * With no last good data, throws BusyError when the RPC budget says no, or the read's error.
 */
export async function getCoinDetail(mint: string, wallet: string | null): Promise<CoinDetail | null> {
  const base = await coinAndTrades(mint);
  if (!base) return null;
  return { ...base, holdings: wallet ? await holdingsFor(mint, wallet, base.coin.meteoraPool) : null };
}

async function coinAndTrades(mint: string): Promise<CoinAndTrades | null> {
  const hit = coinCache.get(mint);
  if (hit && Date.now() - hit.at < (hit.value === null ? MISS_CACHE_MS : DETAIL_CACHE_MS)) return hit.value;
  return shareInFlight(coinInFlight, mint, () => refreshCoin(mint, hit?.value));
}

async function refreshCoin(mint: string, previous: CoinAndTrades | null | undefined): Promise<CoinAndTrades | null> {
  const now = Date.now();

  // Cheap existence check first (only when we don't already know the coin): unknown or made-up
  // addresses cost one call and are remembered as misses for 30 s. Only a pool account that is
  // absent counts as a miss; a failed check throws and is not remembered.
  if (!previous) {
    const pool = poolForMint(mint);
    if (!pool) return remember(coinCache, mint, null, now);
    if (!(await takeRpcBudget(EXISTS_RPC_CALLS))) throw new BusyError();
    if (!(await getChain().connection.getAccountInfo(pool))) return remember(coinCache, mint, null, now);
  }

  // From here the coin is ours (its pool exists), and a DBC pool is never closed, so a failed or
  // empty read is transient (429, timeout, a lagging RPC node, mid-graduation): serve the last good
  // data if there is any, and never remember it as a miss.
  try {
    if (!(await takeRpcBudget(COIN_RPC_CALLS - EXISTS_RPC_CALLS))) throw new BusyError();
    const fetched = await readCoinAndTrades(mint);
    if (!fetched) throw new Error(`coin pool read came back empty: ${mint}`);
    const value = fetched.trades.length === 0 && previous?.trades.length ? { ...fetched, trades: previous.trades } : fetched;
    return remember(coinCache, mint, value, now);
  } catch (error) {
    if (!previous) throw error;
    console.warn("coin read failed; serving the last good data:", (error as Error).message);
    return remember(coinCache, mint, previous, now);
  }
}

async function holdingsFor(mint: string, wallet: string, meteoraPool: string | null): Promise<Holdings | null> {
  const key = `${mint}|${wallet}`;
  const now = Date.now();
  const hit = holdingsCache.get(key);
  if (hit && now - hit.at < HOLDINGS_CACHE_MS) return hit.value;
  return shareInFlight(holdingsInFlight, key, async () => {
    const calls = HOLDINGS_RPC_CALLS + (meteoraPool ? LP_FEES_RPC_CALLS : 0);
    if (!(await takeRpcBudget(calls))) throw new BusyError();
    return remember(holdingsCache, key, await walletHoldings(mint, wallet, meteoraPool), Date.now());
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
  const { coin, venue } = loaded;
  const trades = await recentTrades(getChain().client, coin, venue).catch((error) => {
    console.warn("trade history unavailable:", (error as Error).message);
    return [];
  });
  return { coin, trades };
}

/**
 * A coin's top holders: one read per coin per 30 s for everyone (the list moves slowly), budgeted
 * like the detail. If a read fails or the budget says no, the last good list is served.
 */
const HOLDERS_CACHE_MS = 30_000;
/** getTokenLargestAccounts, then one getMultipleAccountsInfo for the mint (supply) and those accounts (owners). */
const HOLDERS_RPC_CALLS = 2;
/**
 * Some RPCs refuse getTokenLargestAccounts (public devnet answers 429 for that method alone). Then
 * one owner+amount scan of the mint's token accounts replaces it, after the mint read: one more call.
 */
const HOLDERS_FALLBACK_RPC_CALLS = 1;
/** After a refusal, skip getTokenLargestAccounts for a while (web3.js retries a 429 for ~8 s first). */
const LARGEST_REFUSED_MS = 10 * 60_000;
let largestRefusedAt = -Infinity;
const holderListCache = new Map<string, { at: number; value: HolderView[] }>();
const holderListInFlight = new Map<string, Promise<HolderView[]>>();

/** Null if it isn't a memestream coin. Throws BusyError when the RPC budget says no and nothing is cached. */
export async function getHolders(mint: string): Promise<HolderView[] | null> {
  const base = await coinAndTrades(mint);
  if (!base) return null;
  const hit = holderListCache.get(mint);
  if (hit && Date.now() - hit.at < HOLDERS_CACHE_MS) return hit.value;
  return shareInFlight(holderListInFlight, mint, async () => {
    if (!(await takeRpcBudget(HOLDERS_RPC_CALLS))) {
      if (hit) return hit.value;
      throw new BusyError();
    }
    try {
      return remember(holderListCache, mint, await readHolders(base.coin), Date.now());
    } catch (error) {
      if (!hit) throw error;
      console.warn("holder read failed; serving the last good list:", (error as Error).message);
      return hit.value;
    }
  });
}

async function readHolders(coin: CoinView): Promise<HolderView[]> {
  const { connection } = getChain();
  const mintKey = new PublicKey(coin.mint);
  const roles = { curve: deriveDbcPoolAuthority().toBase58(), pool: deriveDammV2PoolAuthority().toBase58(), streamer: coin.creator };
  const tryLargest = Date.now() - largestRefusedAt >= LARGEST_REFUSED_MS;
  const largest = !tryLargest
    ? null
    : await connection.getTokenLargestAccounts(mintKey).then(
          (r) => r.value,
          (error: Error) => {
            console.warn("getTokenLargestAccounts refused; scanning the mint's token accounts:", error.message);
            largestRefusedAt = Date.now();
            return null;
          },
        );
  if (largest) {
    const [mintInfo, ...accounts] = await connection.getMultipleAccountsInfo([mintKey, ...largest.map((a) => a.address)]);
    const supply = mintSupply(mintInfo?.data ?? null);
    const balances = largest.map((a, i) => ({ owner: tokenAccountOwner(accounts[i]?.data ?? null), amount: BigInt(a.amount) }));
    return supply === null ? [] : toHolders(balances, supply, roles);
  }
  // The refused call used one of the two calls drawn; the scan and the mint read need one more.
  if (tryLargest && !(await takeRpcBudget(HOLDERS_FALLBACK_RPC_CALLS))) throw new BusyError();
  const [mintInfo, scanned] = await Promise.all([
    connection.getAccountInfo(mintKey),
    connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      dataSlice: OWNER_AMOUNT_SLICE,
      filters: [{ dataSize: AccountLayout.span }, { memcmp: { offset: 0, bytes: coin.mint } }],
    }),
  ]);
  const supply = mintSupply(mintInfo?.data ?? null);
  return supply === null ? [] : toHolders(scanned.map(({ account }) => slicedOwnerAmount(account.data)), supply, roles);
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
  const coins = await listPublicCoins();
  const tradesByMint = new Map<string, TradeView[]>();
  for (const [mint, entry] of coinCache) if (entry.value) tradesByMint.set(mint, entry.value.trades);
  return buildTape(coins, tradesByMint, Math.floor(Date.now() / 1000));
}

const TRADE_HISTORY_LIMIT = 25;

/** The pool's last few swaps (two RPC calls); other transactions on the pool are skipped. */
async function recentTrades(client: DynamicBondingCurveClient, coin: CoinView, { address, vaults }: TradeVenue): Promise<TradeView[]> {
  const signatures = await client.connection.getSignaturesForAddress(address, { limit: TRADE_HISTORY_LIMIT });
  const transactions = await client.connection.getParsedTransactions(
    signatures.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0 },
  );
  return transactions.flatMap((tx, i) => tradeFromTransaction(tx, signatures[i].signature, { vaults, creator: coin.creator }) ?? []);
}

/** A wallet's SOL and its balance of one coin (0 if it has no token account yet). */
async function walletHoldings(mint: string, wallet: string, meteoraPool: string | null): Promise<Holdings | null> {
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
  return { sol: lamportsToSol(new BN(lamports)), coins: baseUnitsToCoins(new BN(tokens)), lpFees: await lpFeesOf(meteoraPool, owner) };
}

/** Unclaimed fees on the LP position NFTs `owner` holds in a graduated coin's pool; null if none. */
async function lpFeesOf(meteoraPool: string | null, owner: PublicKey): Promise<Holdings["lpFees"]> {
  if (!meteoraPool) return null;
  const { connection } = getChain();
  const pool = new PublicKey(meteoraPool);
  try {
    const [positions, [state]] = await Promise.all([lpPositionsOf(connection, pool, owner, chargeRpcBudget), fetchDammPools(connection, [pool])]);
    if (positions.length === 0 || !state) return null;
    const { coins, lamports } = unclaimedPoolFees(state, positions);
    return { sol: lamportsToSol(lamports), coins: baseUnitsToCoins(coins) };
  } catch (error) {
    // A failed LP lookup must not break the coin page: the section is hidden until the next poll.
    console.warn("LP fees unavailable:", (error as Error).message);
    return null;
  }
}
