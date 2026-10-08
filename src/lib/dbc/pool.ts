/** Reading a stream coin pool's live state, and turning it into plain data for the UI. */
import {
  ActivationType,
  type DynamicBondingCurveClient,
  getPriceFromSqrtPrice,
  type PoolConfig,
  type TokenDecimal,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { CoinStatus, CoinView } from "../api-types";
import { baseUnitsToCoins, lamportsToSol, QUOTE } from "./units";

/**
 * CoinStatus:
 * - trading: the curve is open.
 * - graduating: the curve holds the threshold; waiting for migration to DAMM v2.
 * - graduated: liquidity moved to DAMM v2; trade there, not here.
 */
export type { CoinStatus };

/** Fresh on-chain state needed to price a trade. Load a new one before every quote. */
export type PoolSnapshot = {
  address: PublicKey;
  pool: VirtualPool;
  config: PoolConfig;
  /** The "now" the fee scheduler uses (block time or slot, per the config). */
  currentPoint: BN;
  status: CoinStatus;
};

/** A config never changes after creation, so it is safe to keep. */
const configCache = new Map<string, PoolConfig>();

/** A pool's config, cached forever (configs are immutable). */
export async function loadConfig(client: DynamicBondingCurveClient, address: PublicKey): Promise<PoolConfig> {
  const key = address.toBase58();
  const hit = configCache.get(key);
  if (hit) return hit;
  const config = await client.state.getPoolConfig(address);
  if (!config) throw new Error(`Pool config not found: ${key}`);
  configCache.set(key, config);
  return config;
}

const BLOCK_TIME_LOOKBACK_SLOTS = 5;

/**
 * Block time near the tip. The newest slot often has no time yet on public RPCs, so step back.
 * A slightly old time is safe: the launch fee only falls, so it quotes a higher fee, never lower.
 */
async function recentBlockTime(connection: Connection): Promise<BN> {
  const slot = await connection.getSlot();
  for (let back = 0; back <= BLOCK_TIME_LOOKBACK_SLOTS; back++) {
    const time = await connection.getBlockTime(slot - back).catch(() => null);
    if (time !== null) return new BN(time);
  }
  throw new Error(`No block time near slot ${slot}`);
}

async function currentPointFor(connection: Connection, config: PoolConfig): Promise<BN> {
  return config.activationType === ActivationType.Slot
    ? new BN(await connection.getSlot())
    : recentBlockTime(connection);
}

export function statusOf(pool: VirtualPool, config: PoolConfig): CoinStatus {
  if (pool.poolState.isMigrated !== 0) return "graduated";
  if (pool.poolState.quoteReserve.gte(config.migrationQuoteThreshold)) return "graduating";
  return "trading";
}

export async function loadPoolSnapshot(
  client: DynamicBondingCurveClient,
  address: PublicKey,
): Promise<PoolSnapshot> {
  const pool = await client.state.getPool(address);
  if (!pool) throw new Error(`Pool not found: ${address.toBase58()}`);
  const config = await loadConfig(client, pool.poolState.config);
  const currentPoint = await currentPointFor(client.connection, config);
  return { address, pool, config, currentPoint, status: statusOf(pool, config) };
}

/** Share of the graduation threshold already in the curve, from 0 to 1. Drives the XP bar. */
export function graduationProgress(snapshot: Pick<PoolSnapshot, "pool" | "config">): number {
  const threshold = snapshot.config.migrationQuoteThreshold;
  if (threshold.isZero()) return 0;
  // Basis points keep the BN division exact enough for a progress bar.
  const bps = snapshot.pool.poolState.quoteReserve.muln(10_000).div(threshold).toNumber();
  return Math.min(Math.max(bps / 10_000, 0), 1);
}

/** Price of one coin in SOL on the curve. After graduation this is the last curve price. */
export function priceInSol(snapshot: Pick<PoolSnapshot, "pool" | "config">): number {
  return getPriceFromSqrtPrice(
    snapshot.pool.poolState.sqrtPrice,
    snapshot.config.tokenDecimal as TokenDecimal,
    QUOTE.decimals,
  ).toNumber();
}

/** Plain, JSON-safe view of a coin pool for the UI (metadata fields are added by the server). */
export type PoolView = Omit<CoinView, "name" | "symbol" | "streamUrl">;

/** Pool state plus its config; enough to describe a coin without a fresh clock reading. */
type PoolState = Pick<PoolSnapshot, "address" | "pool" | "config">;

export function toPoolView({ address, pool, config }: PoolState): PoolView {
  const { poolState } = pool;
  const price = getPriceFromSqrtPrice(poolState.sqrtPrice, config.tokenDecimal as TokenDecimal, QUOTE.decimals).toNumber();
  const supply = Number(baseUnitsToCoins(config.preMigrationTokenSupply));
  const threshold = config.migrationQuoteThreshold;
  return {
    pool: address.toBase58(),
    mint: poolState.baseMint.toBase58(),
    creator: poolState.creator.toBase58(),
    status: statusOf(pool, config),
    progress: graduationProgress({ pool, config }),
    priceSol: price,
    marketCapSol: price * supply,
    raisedSol: lamportsToSol(BN.min(poolState.quoteReserve, threshold)),
    thresholdSol: lamportsToSol(threshold),
    streamerUnclaimedSol: lamportsToSol(poolState.creatorQuoteFee),
    launchedAt: poolState.activationPoint.toNumber(),
  };
}
