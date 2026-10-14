/** The mainnet createConfig transaction: the mainnet preset, the owner's wallet as fee claimer and leftover receiver. */
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { type AccountInfo, type Connection, type Keypair, PublicKey } from "@solana/web3.js";
import { buildCreateConfigParams, buildCreateConfigTx, configMismatches } from "../../src/lib/dbc/config";
import { COIN_PRESETS, MAINNET_PARTNER_WALLET } from "../../src/lib/dbc/preset";
import { prepareAndSimulate } from "./common";

export const MAINNET_PRESET = COIN_PRESETS["mainnet-beta"];

const ownerWallets = (payer: PublicKey) => {
  const owner = new PublicKey(MAINNET_PARTNER_WALLET);
  return { payer, feeClaimer: owner, leftoverReceiver: owner };
};

/** Builds, adds blockhash and priority fee, and simulates. Unsigned: the caller signs with payer + configKey. */
export async function prepareMainnetConfig(connection: Connection, payer: PublicKey, configKey: Keypair) {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const wallets = ownerWallets(payer);
  const params = buildCreateConfigParams(MAINNET_PRESET, { ...wallets, config: configKey.publicKey });
  const built = await buildCreateConfigTx(client, MAINNET_PRESET, wallets, configKey);
  return { built, params, ...(await prepareAndSimulate(connection, built.tx)) };
}

/**
 * Why the account at `address` is NOT our mainnet config; empty if it is: owned by the DBC
 * program, decodes as a config, and every immutable value equals what we'd create (owner wallet
 * as claimer and receiver, mainnet preset, SOL quote). Anything else must never go into
 * MEMESTREAM_CONFIG.
 */
export async function existingConfigProblems(connection: Connection, address: PublicKey, info: AccountInfo<Buffer>): Promise<string[]> {
  if (!info.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) return [`it is owned by ${info.owner.toBase58()}, not the DBC program`];
  const onChain = await new DynamicBondingCurveClient(connection, "confirmed").state.getPoolConfig(address).catch(() => null);
  if (!onChain) return ["it doesn't decode as a DBC config"];
  // The payer isn't stored in the config, so any key stands in for it.
  const expected = buildCreateConfigParams(MAINNET_PRESET, { ...ownerWallets(address), config: address });
  return configMismatches(onChain, expected);
}
