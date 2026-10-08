/**
 * DEVNET ONLY: creates the memestream DBC config on real devnet, paid by .keys/partner.json.
 * Run once after funding the partner wallet with devnet SOL:  npx tsx scripts/devnet-config.mts
 * Prints the config address for MEMESTREAM_CONFIG. Never points at mainnet.
 */
import { readFileSync } from "node:fs";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { buildCreateConfigTx } from "../src/lib/dbc/config";
import { COIN_PRESETS } from "../src/lib/dbc/preset";
import { sendAndConfirm } from "./local-chain/send-and-confirm";

const DEVNET_RPC = "https://api.devnet.solana.com";
const MIN_SOL = 0.05;

const partner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/partner.json", "utf8"))));
const connection = new Connection(DEVNET_RPC, "confirmed");
if ((await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
  throw new Error("Not devnet. Stopping.");
}
const balance = (await connection.getBalance(partner.publicKey)) / LAMPORTS_PER_SOL;
if (balance < MIN_SOL) throw new Error(`Partner ${partner.publicKey.toBase58()} has ${balance} devnet SOL; fund it first.`);

const client = new DynamicBondingCurveClient(connection, "confirmed");
const configTx = await buildCreateConfigTx(client, COIN_PRESETS.devnet, {
  payer: partner.publicKey,
  feeClaimer: partner.publicKey,
  leftoverReceiver: partner.publicKey,
});
const signature = await sendAndConfirm(connection, configTx, [partner]);
console.log(`config ${configTx.config.toBase58()}\nsignature ${signature}\nSet MEMESTREAM_CONFIG to the config address.`);
