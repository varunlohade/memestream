/**
 * Each market trades in ONE Meteora DAMM v2 pool of YES (token A) against NO (token B), both 9
 * decimals, the way a Gnosis FPMM does: a bet splits SOL into YES + NO and swaps the side it doesn't
 * want for the side it does (trade.ts), so any size fills and only the price moves.
 *
 * The pool's price p is NO per YES; the market's probability of YES is p / (1 + p), and a share of
 * YES costs that much SOL at the margin. The pool starts at p = 1 (50/50) on p = 0.001 to 1000, so
 * its liquidity covers probabilities from about 0.1% to 99.9%.
 */
import {
  ActivationType,
  BaseFeeMode,
  bpsToFeeNumerator,
  CollectFeeMode,
  deriveCustomizablePoolAddress,
  getAmountAFromLiquidityDelta,
  getAmountBFromLiquidityDelta,
  getBaseFeeHandlerFromPodAlignedData,
  getBaseFeeParams,
  getLiquidityDeltaFromAmountA,
  getLiquidityDeltaFromAmountB,
  getSqrtPriceFromPrice,
  type PoolFeesParams,
  Rounding,
} from "@meteora-ag/cp-amm-sdk";
import type { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { InputError } from "../dbc/errors";
import { type DammSnapshot, loadDammSnapshot } from "../damm/pool";
import { type MarketOdds, oddsFromPrices, priceFromSqrtPrice, questionIdFor } from "./math";
import { vaultKeys, type VaultKeys } from "./vault";

export const OUTCOME_DECIMALS = 9;

/** 0.3% swap fee, flat (no fee scheduler, no dynamic fee), in the token paid in, to the pool's LP (the oracle's seed). */
export const MARKET_FEE_BPS = 30;
const sqrtPrice = (price: string) => getSqrtPriceFromPrice(price, OUTCOME_DECIMALS, OUTCOME_DECIMALS);
export const PRICE_RANGE = { min: sqrtPrice("0.001"), max: sqrtPrice("1000"), start: sqrtPrice("1") };
/** Fees in the input token (YES or NO), on a fixed price range (concentrated liquidity). */
export const COLLECT_FEE_MODE = CollectFeeMode.BothToken;
export const ACTIVATION_TYPE = ActivationType.Timestamp;

export function marketPoolFees(): PoolFeesParams {
  const baseFee = getBaseFeeParams(
    {
      baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
      feeTimeSchedulerParam: { startingFeeBps: MARKET_FEE_BPS, endingFeeBps: MARKET_FEE_BPS, numberOfPeriod: 0, totalDuration: 0 },
    },
    OUTCOME_DECIMALS,
    ACTIVATION_TYPE,
  );
  return { baseFee, compoundingFeeBps: 0, padding: 0, dynamicFee: null };
}

export type SeedPlan = {
  /** The SOL split into YES + NO: `lamports` of each. */
  lamports: BN;
  /** The pool's starting liquidity, and the YES and NO it takes for it (each at most `lamports`). */
  liquidity: BN;
  yes: BN;
  no: BN;
};

/** Seeding with S SOL: split into S YES + S NO, both deposited at 1:1 (50/50). Any rounding dust stays with the oracle. */
export function seedPlan(lamports: BN): SeedPlan {
  const { min, max, start } = PRICE_RANGE;
  const liquidity = BN.min(
    getLiquidityDeltaFromAmountA(lamports, start, max, COLLECT_FEE_MODE),
    getLiquidityDeltaFromAmountB(lamports, min, start, COLLECT_FEE_MODE),
  );
  const yes = getAmountAFromLiquidityDelta(start, max, liquidity, Rounding.Up, COLLECT_FEE_MODE);
  const no = getAmountBFromLiquidityDelta(min, start, liquidity, Rounding.Up, COLLECT_FEE_MODE);
  return { lamports, liquidity, yes, no };
}

export type MarketKeys = VaultKeys & {
  oracle: PublicKey;
  questionId: Uint8Array;
  /** The YES/NO pool. */
  pool: PublicKey;
};

/** Every address of a market, from its question id and oracle: no lookups. */
export function marketKeysFromId(connection: Connection, questionId: Uint8Array, oracle: PublicKey): MarketKeys {
  const vault = vaultKeys(connection, questionId, oracle);
  return { ...vault, oracle, questionId, pool: deriveCustomizablePoolAddress(vault.mints.yes, vault.mints.no) };
}

/** A coin prediction's market; `secret` is the server's market secret (see questionIdFor). */
export const marketKeys = (connection: Connection, secret: string, coinMint: PublicKey, predictionId: string, oracle: PublicKey): MarketKeys =>
  marketKeysFromId(connection, questionIdFor(secret, coinMint, predictionId), oracle);

export type MarketPool = DammSnapshot;

/** The market's pool, or null if it has none (not created yet). */
export async function loadMarketPool(connection: Connection, keys: MarketKeys): Promise<MarketPool | null> {
  const pool = await loadDammSnapshot(connection, keys.pool);
  if (pool) return pool;
  // loadDammSnapshot reads a failed RPC call (a rate limit) as "no pool": ask once more, so an RPC
  // error surfaces as one (busy, try again) rather than as "no market".
  if (await connection.getAccountInfo(keys.pool)) throw new Error("Couldn't read the market's pool: RPC rate limit or outage");
  return null;
}

/** The probability of YES at a pool sqrt price: p / (1 + p), with p = NO per YES. */
export function yesProbability(sqrtPriceQ64: BN): number {
  const p = priceFromSqrtPrice(BigInt(sqrtPriceQ64.toString()));
  return p / (1 + p);
}

/** The pool's spot odds: what a share of each side costs at the margin, summing to 1. */
export function marketOdds(pool: MarketPool): MarketOdds {
  const yes = yesProbability(pool.state.sqrtPrice);
  return oddsFromPrices(yes, 1 - yes);
}

const NOT_OURS = "This market's pool doesn't match memestream's, so trading is off for it";

/**
 * A pool at a market's address is ours only if it is exactly what buildCreateMarketTxs makes: anyone
 * can create a pool at that address first, with the tokens the other way round, another range or
 * fee. Token A must be YES and B NO (the trade builders assume it), on our price range, with our
 * flat fee, no dynamic fee, our fee mode, and already active. This says nothing about who made the
 * pool: provenance.ts checks that.
 */
export function verifyMarketPool(keys: MarketKeys, pool: MarketPool): void {
  const { state, address, currentPoint } = pool;
  if (!address.equals(keys.pool) || state.activationPoint.gt(currentPoint)) throw new InputError(NOT_OURS);
  if (!state.tokenAMint.equals(keys.mints.yes) || !state.tokenBMint.equals(keys.mints.no)) throw new InputError(NOT_OURS);
  if (!state.sqrtMinPrice.eq(PRICE_RANGE.min) || !state.sqrtMaxPrice.eq(PRICE_RANGE.max)) throw new InputError(NOT_OURS);
  if (state.collectFeeMode !== COLLECT_FEE_MODE || state.poolFees.dynamicFee.initialized !== 0) throw new InputError(NOT_OURS);
  const fee = getBaseFeeHandlerFromPodAlignedData(state.poolFees.baseFee.baseFeeInfo.data);
  const ours = bpsToFeeNumerator(MARKET_FEE_BPS);
  if (!fee.getMinFeeNumerator().eq(ours) || !fee.getMaxFeeNumerator().eq(ours)) throw new InputError(NOT_OURS);
}
