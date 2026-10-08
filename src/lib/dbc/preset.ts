/**
 * The memestream launch preset: one Meteora DBC config shared by every stream coin.
 *
 * DBC vocabulary used below:
 * - "partner" = memestream (owns the config, claims the platform fee share).
 * - "creator" = the streamer (must be the pool creator to receive the creator fee share).
 */
import {
  ActivationType,
  BaseFeeMode,
  buildCurve,
  CollectFeeMode,
  type ConfigParameters,
  type FeeSchedulerParams,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { BASE_DECIMALS, QUOTE } from "./units";

export type Network = "devnet" | "mainnet-beta";

/** Knobs that differ between devnet testing and mainnet launch. */
export type CoinPreset = {
  /** SOL in the curve that triggers graduation to DAMM v2, as a decimal string. */
  graduationThresholdSol: string;
};

export const COIN_PRESETS: Record<Network, CoinPreset> = {
  // Tiny, so a tester graduates a coin with faucet SOL. The real programs accept it, including
  // graduation to DAMM v2 (test/integration/lifecycle.surfpool.ts).
  devnet: { graduationThresholdSol: "0.1" },
  // Boss man's pick (2026-10-08). Config params are fixed once the mainnet config is created.
  "mainnet-beta": { graduationThresholdSol: "10" },
};

const TOTAL_SUPPLY = 1_000_000_000;

/** Fee times below are in seconds because activation is by timestamp. */
const ACTIVATION_TYPE = ActivationType.Timestamp;

/**
 * Anti-sniper fee: 50% at launch, falling to a 1% base over the first minute.
 * The dynamic (volatility) fee below adds a small extra on top during wild price swings.
 */
export const LAUNCH_FEE = {
  startingFeeBps: 5_000,
  endingFeeBps: 100,
  numberOfPeriod: 60,
  totalDuration: 60,
} satisfies FeeSchedulerParams;

/**
 * Share of trading fees paid to the pool creator (the streamer).
 * The rest goes to the partner (memestream).
 */
const CREATOR_FEE_SHARE_PERCENT = 80;

/** Supply that moves into the DAMM v2 pool at graduation; the rest is sold on the curve. */
const SUPPLY_FOR_GRADUATION_PERCENT = 20;

/** All graduated liquidity is locked forever, split between platform and streamer. */
const LP_LOCK_PERCENT = { partner: 50, creator: 50 };

/** Swap fee on the graduated DAMM v2 pool (not a fee taken at migration). */
const GRADUATED_POOL_FEE = MigrationFeeOption.FixedBps100;

/** Streamers launch for free. */
const POOL_CREATION_FEE_SOL = 0;

/**
 * No creator vesting. Graduation (graduate.ts) relies on this: with vesting, a locker
 * must be created before migration, which we don't do.
 */
export const NO_LOCKED_VESTING = {
  totalLockedVestingAmount: 0,
  numberOfVestingPeriod: 0,
  cliffUnlockAmount: 0,
  totalVestingDuration: 0,
  cliffDurationFromMigrationTime: 0,
};

function assertWholeFeePeriods(fee: FeeSchedulerParams) {
  // The SDK floors totalDuration / numberOfPeriod, which would shorten the schedule silently.
  if (fee.totalDuration % fee.numberOfPeriod !== 0) {
    throw new Error("LAUNCH_FEE.totalDuration must divide evenly by numberOfPeriod");
  }
}

/** Curve and fee parameters for the shared coin config. */
export function buildCoinConfig(preset: CoinPreset): ConfigParameters {
  assertWholeFeePeriods(LAUNCH_FEE);
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: BASE_DECIMALS,
      tokenQuoteDecimal: QUOTE.decimals,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: TOTAL_SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: LAUNCH_FEE,
      },
      // Adds a small volatility fee on top of the base during hype spikes; protects the curve.
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: CREATOR_FEE_SHARE_PERCENT,
      poolCreationFee: POOL_CREATION_FEE_SOL,
      // The streamer should not buy their own coin, so no cheap first swap.
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: GRADUATED_POOL_FEE,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: LP_LOCK_PERCENT.partner,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: LP_LOCK_PERCENT.creator,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: NO_LOCKED_VESTING,
    activationType: ACTIVATION_TYPE,
    percentageSupplyOnMigration: SUPPLY_FOR_GRADUATION_PERCENT,
    // buildCurve converts through Decimal, so the float here is exact enough.
    migrationQuoteThreshold: Number(preset.graduationThresholdSol),
  });
}
