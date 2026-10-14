/** One-time platform (partner) action: create the shared DBC config on-chain. */
import {
  type CreateConfigParams,
  type DynamicBondingCurveClient,
  type PoolConfig,
  validateConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { buildCoinConfig, type CoinPreset } from "./preset";
import { type BuiltTx, built } from "./tx";
import { QUOTE } from "./units";

export type ConfigAccounts = {
  /** Address of the new config account. */
  config: PublicKey;
  payer: PublicKey;
  /** Wallet that claims the partner fee share. */
  feeClaimer: PublicKey;
  /** Wallet that receives unsold tokens after graduation. */
  leftoverReceiver: PublicKey;
};

/** Full, validated params for PartnerService.createConfig. The one path to a config. */
export function buildCreateConfigParams(
  preset: CoinPreset,
  accounts: ConfigAccounts,
): CreateConfigParams {
  const params: CreateConfigParams = {
    ...buildCoinConfig(preset),
    ...accounts,
    quoteMint: QUOTE.mint,
  };
  validateConfigParameters(params);
  return params;
}

/**
 * Creates the config at a fresh address (or at `configKey`, e.g. one saved to a file so a dry run
 * and the real send use the same address); that keypair is returned in `localSigners`.
 */
export async function buildCreateConfigTx(
  client: DynamicBondingCurveClient,
  preset: CoinPreset,
  wallets: Omit<ConfigAccounts, "config">,
  configKey: Keypair = Keypair.generate(),
): Promise<BuiltTx & { config: PublicKey }> {
  const params = buildCreateConfigParams(preset, { ...wallets, config: configKey.publicKey });
  const tx = await client.partner.createConfig(params);
  return { ...built(tx, wallets.payer, [configKey]), config: configKey.publicKey };
}

/** Plain values compare as strings: BN, PublicKey, numbers and 0/1 flags all print the same way. */
const same = (a: unknown, b: unknown) => String(a) === String(b);

const DYNAMIC_FEE_KEYS = ["binStep", "binStepU128", "filterPeriod", "decayPeriod", "reductionFactor", "maxVolatilityAccumulator", "variableFeeControl"] as const;
const SAME_NAME_KEYS = [
  "collectFeeMode",
  "migrationOption",
  "activationType",
  "tokenDecimal",
  "tokenType",
  "partnerLiquidityPercentage",
  "partnerPermanentLockedLiquidityPercentage",
  "creatorLiquidityPercentage",
  "creatorPermanentLockedLiquidityPercentage",
  "migrationFeeOption",
  "creatorTradingFeePercentage",
  "tokenUpdateAuthority",
  "migrationQuoteThreshold",
  "sqrtStartPrice",
  "poolCreationFee",
] as const;
const VESTING_KEYS = ["amountPerPeriod", "cliffDurationFromMigrationTime", "frequency", "numberOfPeriod", "cliffUnlockAmount"] as const;

/**
 * Every immutable value where an on-chain config differs from the params we would create it with;
 * empty means it is exactly ours. Used before trusting an existing config (scripts/mainnet-config.mts).
 */
export function configMismatches(onChain: PoolConfig, expected: CreateConfigParams): string[] {
  const out: string[] = [];
  const check = (label: string, actual: unknown, want: unknown) => {
    if (!same(actual, want)) out.push(`${label}: on chain ${String(actual)}, expected ${String(want)}`);
  };
  check("quote mint", onChain.quoteMint, expected.quoteMint);
  check("fee claimer", onChain.feeClaimer, expected.feeClaimer);
  check("leftover receiver", onChain.leftoverReceiver, expected.leftoverReceiver);
  const base = expected.poolFees.baseFee;
  check("launch fee start", onChain.poolFees.baseFee.cliffFeeNumerator, base.cliffFeeNumerator);
  check("launch fee periods", onChain.poolFees.baseFee.firstFactor, base.firstFactor);
  check("launch fee period length", onChain.poolFees.baseFee.secondFactor, base.secondFactor);
  check("launch fee step", onChain.poolFees.baseFee.thirdFactor, base.thirdFactor);
  check("base fee mode", onChain.poolFees.baseFee.baseFeeMode, base.baseFeeMode);
  const dyn = expected.poolFees.dynamicFee;
  check("dynamic fee on", onChain.poolFees.dynamicFee.initialized, dyn ? 1 : 0);
  if (dyn) for (const k of DYNAMIC_FEE_KEYS) check(`dynamic fee ${k}`, onChain.poolFees.dynamicFee[k], dyn[k]);
  for (const k of SAME_NAME_KEYS) check(k, onChain[k], expected[k]);
  check("migration fee", onChain.migrationFeePercentage, expected.migrationFee.feePercentage);
  check("creator migration fee", onChain.creatorMigrationFeePercentage, expected.migrationFee.creatorFeePercentage);
  check("graduated pool collect mode", onChain.migratedCollectFeeMode, expected.migratedPoolFee?.collectFeeMode ?? 0);
  check("graduated pool dynamic fee", onChain.migratedDynamicFee, expected.migratedPoolFee?.dynamicFee ?? 0);
  check("graduated pool fee bps", onChain.migratedPoolFeeBps, expected.migratedPoolFee?.poolFeeBps ?? 0);
  check("cheap first swap", onChain.enableFirstSwapWithMinFee, expected.enableFirstSwapWithMinFee ? 1 : 0);
  check("supply before graduation", onChain.preMigrationTokenSupply, expected.tokenSupply?.preMigrationTokenSupply ?? 0);
  check("supply after graduation", onChain.postMigrationTokenSupply, expected.tokenSupply?.postMigrationTokenSupply ?? 0);
  for (const k of VESTING_KEYS) check(`creator vesting ${k}`, onChain.lockedVestingConfig[k], expected.lockedVesting[k]);
  // The on-chain curve is a fixed array, zero-padded after the points we set.
  if (expected.curve.length > onChain.curve.length) out.push(`curve: ${expected.curve.length} points expected, ${onChain.curve.length} on chain`);
  onChain.curve.forEach((point, i) => {
    const want = expected.curve[i] ?? { sqrtPrice: 0, liquidity: 0 };
    check(`curve point ${i} price`, point.sqrtPrice, want.sqrtPrice);
    check(`curve point ${i} liquidity`, point.liquidity, want.liquidity);
  });
  return out;
}
