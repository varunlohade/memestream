/** One-time platform (partner) action: create the shared DBC config on-chain. */
import {
  type CreateConfigParams,
  type DynamicBondingCurveClient,
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

/** Creates the config at a fresh address; that keypair is returned in `localSigners`. */
export async function buildCreateConfigTx(
  client: DynamicBondingCurveClient,
  preset: CoinPreset,
  wallets: Omit<ConfigAccounts, "config">,
): Promise<BuiltTx & { config: PublicKey }> {
  const configKey = Keypair.generate();
  const params = buildCreateConfigParams(preset, { ...wallets, config: configKey.publicKey });
  const tx = await client.partner.createConfig(params);
  return { ...built(tx, wallets.payer, [configKey]), config: configKey.publicKey };
}
