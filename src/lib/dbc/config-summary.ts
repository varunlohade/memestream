/**
 * The createConfig parameters in plain words, read from the exact params that go on chain (not
 * from the preset), so a dry run shows what the program will store. Used by
 * scripts/mainnet-config.mts before anything is sent.
 */
import {
  ActivationType,
  CollectFeeMode,
  type CreateConfigParams,
  FEE_DENOMINATOR,
  getMigrationThresholdPrice,
  getPriceFromSqrtPrice,
  MigrationFeeOption,
  MigrationOption,
  PROTOCOL_FEE_PERCENT,
  PROTOCOL_POOL_CREATION_FEE_PERCENT,
  TokenAuthorityOption,
  TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import type BN from "bn.js";
import { lamportsToSol, QUOTE } from "./units";

const pct = (numerator: BN | number, digits = 2) => `${((Number(numerator) / FEE_DENOMINATOR) * 100).toFixed(digits)}%`;
const sol = (lamports: BN) => `${lamportsToSol(lamports)} SOL`;
const marketCap = (sqrtPrice: BN, decimals: number, supplyCoins: number) =>
  `${getPriceFromSqrtPrice(sqrtPrice, decimals, QUOTE.decimals).mul(supplyCoins).toSignificantDigits(4).toString()} SOL`;

/** One plain line per parameter, as label/value pairs. */
export function describeConfig(params: CreateConfigParams): [string, string][] {
  const { baseFee, dynamicFee } = params.poolFees;
  // Linear fee scheduler: firstFactor periods of secondFactor seconds, thirdFactor less each period.
  const periods = baseFee.firstFactor;
  const endFee = baseFee.cliffFeeNumerator.sub(baseFee.thirdFactor.muln(periods));
  const decimals = params.tokenDecimal;
  const supply = Number(params.tokenSupply?.preMigrationTokenSupply.toString() ?? 0) / 10 ** decimals;
  const graduationSqrtPrice = getMigrationThresholdPrice(params.migrationQuoteThreshold, params.sqrtStartPrice, params.curve);
  const partnerLaunchShare = params.poolCreationFee.muln(100 - PROTOCOL_POOL_CREATION_FEE_PERCENT).divn(100);
  const creator = params.creatorTradingFeePercentage;
  return [
    ["Config address", String(params.config)],
    ["Payer (pays the one-time rent)", String(params.payer)],
    ["Fee claimer (memestream's fee share and launch fees)", String(params.feeClaimer)],
    ["Leftover receiver (unsold coins after graduation)", String(params.leftoverReceiver)],
    ["Quote token", String(params.quoteMint) === QUOTE.mint.toBase58() ? `SOL (${String(params.quoteMint)})` : String(params.quoteMint)],
    ["Coin", `${TokenType[params.tokenType]}, ${decimals} decimals, supply ${supply.toLocaleString("en-US")}`],
    ["Coin metadata authority", TokenAuthorityOption[params.tokenUpdateAuthority] ?? String(params.tokenUpdateAuthority)],
    ["Launch fee schedule", `${pct(baseFee.cliffFeeNumerator, 0)} at launch, falling in ${periods} steps of ${baseFee.secondFactor.toString()} s to ${pct(endFee)} (base fee mode ${baseFee.baseFeeMode} = linear)`],
    ["Volatility (dynamic) fee", dynamicFee ? "on" : "off"],
    ["Fees collected in", params.collectFeeMode === CollectFeeMode.QuoteToken ? "SOL only" : "coin and SOL"],
    ["Trading fee split", `Meteora takes ${PROTOCOL_FEE_PERCENT}% first; of the rest ${creator}% to the streamer, ${100 - creator}% to memestream`],
    ["Cheap first swap for the creator", params.enableFirstSwapWithMinFee ? "on" : "off"],
    ["Launch fee per coin (pool creation fee)", `${sol(params.poolCreationFee)} (memestream gets ${sol(partnerLaunchShare)}, Meteora ${PROTOCOL_POOL_CREATION_FEE_PERCENT}%)`],
    ["Activation", ActivationType[params.activationType] === "Timestamp" ? "by time (seconds)" : "by slot"],
    ["Graduation threshold", `${sol(params.migrationQuoteThreshold)} in the curve`],
    ["Graduates to", MigrationOption[params.migrationOption] ?? String(params.migrationOption)],
    ["Graduated pool fee", MigrationFeeOption[params.migrationFeeOption] ?? String(params.migrationFeeOption)],
    ["Migration fee", `${params.migrationFee.feePercentage}% (creator part ${params.migrationFee.creatorFeePercentage}%)`],
    [
      "Graduated liquidity",
      `streamer ${params.creatorPermanentLockedLiquidityPercentage}% locked forever + ${params.creatorLiquidityPercentage}% unlocked; ` +
        `memestream ${params.partnerPermanentLockedLiquidityPercentage}% locked + ${params.partnerLiquidityPercentage}% unlocked`,
    ],
    ["Creator vesting", params.lockedVesting.amountPerPeriod.isZero() && params.lockedVesting.cliffUnlockAmount.isZero() ? "none" : "SET (graduation code doesn't support it)"],
    ["Curve", `${params.curve.length} point(s); market cap at launch ${marketCap(params.sqrtStartPrice, decimals, supply)}, at graduation ${marketCap(graduationSqrtPrice, decimals, supply)}`],
  ];
}
