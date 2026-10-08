/** LOCAL CHAINS AND DEVNET ONLY: creates the shared config with one wallet in every partner role. */
import type { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { buildCreateConfigTx } from "../../src/lib/dbc/config";
import type { CoinPreset } from "../../src/lib/dbc/preset";
import { sendAndConfirm } from "./send-and-confirm";

/**
 * `partner` pays, claims the partner fee share and receives leftover tokens. Mainnet needs Boss
 * man's real wallet in those roles (MAINNET-CHECKLIST.md), so this is for test chains only.
 */
export async function createConfigOwnedBy(
  client: DynamicBondingCurveClient,
  preset: CoinPreset,
  partner: Keypair,
): Promise<{ config: PublicKey; signature: string }> {
  const built = await buildCreateConfigTx(client, preset, {
    payer: partner.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
  });
  const signature = await sendAndConfirm(client.connection, built, [partner]);
  return { config: built.config, signature };
}
