/**
 * Graduation: once a coin's curve holds the threshold SOL, anyone can move its
 * liquidity into a Meteora DAMM v2 pool. We call this ourselves instead of waiting
 * for Meteora's migrator service, which may not run on devnet.
 */
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  type DynamicBondingCurveClient,
  isDefaultLockedVesting,
  type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Connection, PublicKey } from "@solana/web3.js";
import { InputError } from "./errors";
import type { PoolSnapshot } from "./pool";
import { type BuiltTx, built } from "./tx";

/** The DAMM v2 config that sets the graduated pool's fee tier (index = migrationFeeOption). */
export function dammConfigFor(config: PoolConfig): PublicKey {
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) throw new Error(`No DAMM v2 config for fee option ${config.migrationFeeOption}`);
  return dammConfig;
}

/** Accounts that must already exist on the cluster for migration to work. */
export function requiredGraduationAccounts(config: PoolConfig): Record<string, PublicKey> {
  return {
    "DAMM v2 program": DAMM_V2_PROGRAM_ID,
    "DAMM v2 fee-tier config": dammConfigFor(config),
  };
}

/**
 * Throws with a clear reason if graduation would fail: wrong status, a vesting setup we
 * don't handle (it needs a locker first), or a missing on-chain account.
 */
export async function checkGraduationReady(connection: Connection, snapshot: PoolSnapshot) {
  if (snapshot.status !== "graduating") {
    throw new InputError(`Coin is ${snapshot.status}; it can graduate only once the curve is full`);
  }
  if (!isDefaultLockedVesting(snapshot.config.lockedVestingConfig)) {
    throw new Error("Config has locked vesting; create the locker before migrating (not supported)");
  }
  const accounts = requiredGraduationAccounts(snapshot.config);
  const infos = await connection.getMultipleAccountsInfo(Object.values(accounts));
  const missing = Object.keys(accounts).filter((_, i) => !infos[i]);
  if (missing.length) throw new Error(`Missing on-chain accounts for graduation: ${missing.join(", ")}`);
}

/** Migration to DAMM v2. The two position-NFT keypairs are in `localSigners`. */
export async function buildGraduateTx(
  client: DynamicBondingCurveClient,
  snapshot: PoolSnapshot,
  payer: PublicKey,
): Promise<BuiltTx> {
  await checkGraduationReady(client.connection, snapshot);
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
    await client.migration.migrateToDammV2({
      pool: snapshot.address,
      payer,
      dammConfig: dammConfigFor(snapshot.config),
    });
  return built(transaction, payer, [firstPositionNftKeypair, secondPositionNftKeypair]);
}
