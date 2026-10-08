/**
 * DEVNET ONLY: creates the memestream DBC config on real devnet, paid by .keys/partner.json.
 * Run once after funding the partner wallet with devnet SOL:  npx tsx scripts/devnet-config.mts
 * Prints the config address for MEMESTREAM_CONFIG. Never points at mainnet.
 */
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { COIN_PRESETS } from "../src/lib/dbc/preset";
import { connectToDevnet } from "./devnet";
import { readKeypair } from "./keys";
import { createConfigOwnedBy } from "./local-chain/partner-config";

const MIN_SOL = 0.05;

const partner = readKeypair(".keys/partner.json");
const connection = await connectToDevnet();
const balance = (await connection.getBalance(partner.publicKey)) / LAMPORTS_PER_SOL;
if (balance < MIN_SOL) throw new Error(`Partner ${partner.publicKey.toBase58()} has ${balance} devnet SOL; fund it first.`);

const client = new DynamicBondingCurveClient(connection, "confirmed");
const { config, signature } = await createConfigOwnedBy(client, COIN_PRESETS.devnet, partner);
console.log(`config ${config.toBase58()}\nsignature ${signature}\nSet MEMESTREAM_CONFIG to the config address.`);
