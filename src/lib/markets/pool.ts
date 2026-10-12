/**
 * Each market trades in two Meteora DAMM v2 pools: YES/wSOL and NO/wSOL (outcome = token A,
 * wSOL = token B, both 9 decimals). A pool's price is SOL per outcome token, which is the
 * market's probability for that side.
 *
 * The pools are concentrated on prices 0.001–1 SOL: no one pays more than a token can ever redeem
 * for, and the seed liquidity goes further than over the full price range.
 */
import {
  ActivationType,
  BaseFeeMode,
  bpsToFeeNumerator,
  getBaseFeeHandlerFromPodAlignedData,
  CollectFeeMode,
  deriveCustomizablePoolAddress,
  getAmountAFromLiquidityDelta,
  getBaseFeeParams,
  getLiquidityDeltaFromAmountB,
  getSqrtPriceFromPrice,
  type PoolFeesParams,
  Rounding,
} from "@meteora-ag/cp-amm-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import { InputError } from "../dbc/errors";
import { type DammSnapshot, loadDammSnapshot } from "../damm/pool";
import { questionIdFor, type MarketOdds, oddsFromPrices, priceFromSqrtPrice, type Side } from "./math";
import { vaultKeys, type VaultKeys } from "./vault";

export const OUTCOME_DECIMALS = 9;

/** 1% swap fee, flat (no fee scheduler, no dynamic fee), paid in SOL to the market's LP (the server). */
export const MARKET_FEE_BPS = 100;
const sqrtPrice = (price: string) => getSqrtPriceFromPrice(price, OUTCOME_DECIMALS, OUTCOME_DECIMALS);
export const PRICE_RANGE = { min: sqrtPrice("0.001"), max: sqrtPrice("1"), start: sqrtPrice("0.5") };
/** Fees in SOL only, on a fixed price range (concentrated liquidity). */
export const COLLECT_FEE_MODE = CollectFeeMode.OnlyB;
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
  /** Liquidity each pool starts with. */
  liquidity: BN;
  /** Outcome tokens each pool takes at 0.5: also the SOL to split into YES + NO. */
  outcomeTokens: BN;
  /** SOL each pool takes as its wSOL side. */
  lamportsPerPool: BN;
};

/**
 * Seeding with `lamportsPerPool` SOL on each pool's wSOL side at a 0.5 start price. On the 0.001–1
 * range that needs ~0.61 outcome tokens per SOL, so the whole seed costs ~2.61× `lamportsPerPool`.
 */
export function seedPlan(lamportsPerPool: BN): SeedPlan {
  const liquidity = getLiquidityDeltaFromAmountB(lamportsPerPool, PRICE_RANGE.min, PRICE_RANGE.start, COLLECT_FEE_MODE);
  const outcomeTokens = getAmountAFromLiquidityDelta(PRICE_RANGE.start, PRICE_RANGE.max, liquidity, Rounding.Up, COLLECT_FEE_MODE);
  return { liquidity, outcomeTokens, lamportsPerPool };
}

export type MarketKeys = VaultKeys & {
  oracle: PublicKey;
  questionId: Uint8Array;
  pools: Record<Side, PublicKey>;
};

/** Every address of a market, from its question id and oracle: no lookups. */
export function marketKeysFromId(connection: Connection, questionId: Uint8Array, oracle: PublicKey): MarketKeys {
  const vault = vaultKeys(connection, questionId, oracle);
  const pool = (side: Side) => deriveCustomizablePoolAddress(vault.mints[side], NATIVE_MINT);
  return { ...vault, oracle, questionId, pools: { yes: pool("yes"), no: pool("no") } };
}

/** A coin prediction's market; `secret` is the server's market secret (see questionIdFor). */
export const marketKeys = (connection: Connection, secret: string, coinMint: PublicKey, predictionId: string, oracle: PublicKey): MarketKeys =>
  marketKeysFromId(connection, questionIdFor(secret, coinMint, predictionId), oracle);

export type MarketPools = Record<Side, DammSnapshot>;

/** Both pools, or null if the market has no pools (not created, or a pool is missing). */
export async function loadMarketPools(connection: Connection, keys: MarketKeys): Promise<MarketPools | null> {
  const [yes, no] = await Promise.all([loadDammSnapshot(connection, keys.pools.yes), loadDammSnapshot(connection, keys.pools.no)]);
  return yes && no ? { yes, no } : null;
}

/** Price and probability per side, from the pools' current prices. */
export function marketOdds(pools: MarketPools): MarketOdds {
  const price = (side: Side) => priceFromSqrtPrice(BigInt(pools[side].state.sqrtPrice.toString()));
  return oddsFromPrices(price("yes"), price("no"));
}

const NOT_OURS = "This market's pools don't match memestream's, so trading is off for it";

/**
 * A pool at a market's address is ours only if it is exactly what buildCreateMarketTxs makes: anyone
 * can create a pool at that address first, with the tokens the other way round, another range or
 * fee. Token A must be the outcome and B wSOL (the trade builders assume it), on our price range,
 * with our flat 1% fee, no dynamic fee, and fees collected in SOL. These never change, so a pass can be cached.
 */
export function verifyMarketPools(keys: MarketKeys, pools: MarketPools): void {
  for (const side of ["yes", "no"] as const) {
    const { state, address } = pools[side];
    if (!address.equals(keys.pools[side])) throw new InputError(NOT_OURS);
    if (!state.tokenAMint.equals(keys.mints[side]) || !state.tokenBMint.equals(NATIVE_MINT)) throw new InputError(NOT_OURS);
    if (!state.sqrtMinPrice.eq(PRICE_RANGE.min) || !state.sqrtMaxPrice.eq(PRICE_RANGE.max)) throw new InputError(NOT_OURS);
    if (state.collectFeeMode !== COLLECT_FEE_MODE || state.poolFees.dynamicFee.initialized !== 0) throw new InputError(NOT_OURS);
    const fee = getBaseFeeHandlerFromPodAlignedData(state.poolFees.baseFee.baseFeeInfo.data);
    const ours = bpsToFeeNumerator(MARKET_FEE_BPS);
    if (!fee.getMinFeeNumerator().eq(ours) || !fee.getMaxFeeNumerator().eq(ours)) throw new InputError(NOT_OURS);
  }
}
