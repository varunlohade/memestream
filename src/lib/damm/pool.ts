/**
 * After graduation a coin trades in a Meteora DAMM v2 pool (constant product), made by the DBC
 * migration. The pool address comes from the DAMM v2 fee-tier config our DBC config migrates to,
 * the coin's mint (token A) and SOL (token B): no account scan needed.
 */
import { ActivationType, CpAmm, getPriceFromSqrtPrice, type PoolState } from "@meteora-ag/cp-amm-sdk";
import { deriveDammV2PoolAddress, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { type Connection, type PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import BN from "bn.js";
import { dammConfigFor } from "../dbc/graduate";
import { BASE_DECIMALS, QUOTE } from "../dbc/units";

export const graduatedPoolAddress = (config: PoolConfig, baseMint: PublicKey): PublicKey =>
  deriveDammV2PoolAddress(dammConfigFor(config), baseMint, QUOTE.mint);

export type DammSnapshot = {
  address: PublicKey;
  state: PoolState;
  /** The pool's clock (slot or timestamp, per its activation type): fees depend on it. */
  currentPoint: BN;
};

/** The graduated pool's state, or null if it doesn't exist (yet). */
export async function loadDammSnapshot(connection: Connection, address: PublicKey): Promise<DammSnapshot | null> {
  const cpAmm = new CpAmm(connection);
  const state = await cpAmm.fetchPoolState(address).catch(() => null);
  if (!state) return null;
  const currentPoint = await clockPoint(connection, state.activationType);
  return { address, state, currentPoint };
}

/**
 * The on-chain Clock the program itself checks (slot, or unix time). Read directly rather than
 * via getBlockTime(latest slot), which can lag the clock or be missing, and would make a live
 * pool look not yet open.
 */
async function clockPoint(connection: Connection, activationType: number): Promise<BN> {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!clock) throw new Error("Clock sysvar unavailable");
  // Clock layout: slot u64 @0, epoch_start_timestamp i64 @8, epoch u64 @16, leader_schedule_epoch u64 @24, unix_timestamp i64 @32.
  return activationType === ActivationType.Slot
    ? new BN(clock.data.readBigUInt64LE(0).toString())
    : new BN(clock.data.readBigInt64LE(32).toString());
}

/** SOL per coin in the graduated pool. */
export const dammPriceInSol = (state: PoolState): number =>
  Number(getPriceFromSqrtPrice(state.sqrtPrice, BASE_DECIMALS, QUOTE.decimals));
