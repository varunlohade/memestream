/** The mainnet createConfig transaction: the mainnet preset, the owner's wallet as fee claimer and leftover receiver. */
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { type Connection, type Keypair, PublicKey } from "@solana/web3.js";
import { buildCreateConfigParams, buildCreateConfigTx } from "../../src/lib/dbc/config";
import { COIN_PRESETS, MAINNET_PARTNER_WALLET } from "../../src/lib/dbc/preset";
import { prepareAndSimulate } from "./common";

export const MAINNET_PRESET = COIN_PRESETS["mainnet-beta"];

/** Builds, adds blockhash and priority fee, and simulates. Unsigned: the caller signs with payer + configKey. */
export async function prepareMainnetConfig(connection: Connection, payer: PublicKey, configKey: Keypair) {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const owner = new PublicKey(MAINNET_PARTNER_WALLET);
  const wallets = { payer, feeClaimer: owner, leftoverReceiver: owner };
  const params = buildCreateConfigParams(MAINNET_PRESET, { ...wallets, config: configKey.publicKey });
  const built = await buildCreateConfigTx(client, MAINNET_PRESET, wallets, configKey);
  return { built, params, ...(await prepareAndSimulate(connection, built.tx)) };
}
