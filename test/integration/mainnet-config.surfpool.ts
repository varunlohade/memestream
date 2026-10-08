// The MAINNET preset on the real DBC program (offline local chain): the config is accepted with a
// 10 SOL threshold and a 0.05 SOL launch fee, and launching a coin actually charges that fee.
// Mainnet config params are fixed forever once created, so they're proven here first.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair } from "@solana/web3.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { buildCreateConfigTx } from "../../src/lib/dbc/config";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { COIN_PRESETS } from "../../src/lib/dbc/preset";
import { solToLamports } from "../../src/lib/dbc/units";

const preset = COIN_PRESETS["mainnet-beta"];
const [partner, streamer, freeStreamer] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
let surfnet: Surfnet;
let client: DynamicBondingCurveClient;

before(async () => {
  surfnet = await startOfflineSurfnet([partner, streamer, freeStreamer]);
  client = new DynamicBondingCurveClient(new Connection(surfnet.rpcUrl, "confirmed"), "confirmed");
});
after(() => surfnet?.stop());

test("the mainnet preset creates a config with a 10 SOL threshold and a 0.05 SOL launch fee", async () => {
  const built = await buildCreateConfigTx(client, preset, { payer: partner.publicKey, feeClaimer: partner.publicKey, leftoverReceiver: partner.publicKey });
  await sendAndConfirm(client.connection, built, [partner]);
  const onChain = await client.state.getPoolConfig(built.config);
  assert.ok(onChain, "config exists");
  assert.equal(onChain.migrationQuoteThreshold.toString(), solToLamports(preset.graduationThresholdSol).toString());
  assert.equal(onChain.poolCreationFee.toString(), solToLamports(String(preset.launchFeeSol)).toString());

  // Launching charges exactly the fee on top of what a free launch costs (same rent and network fees).
  const free = await buildCreateConfigTx(client, COIN_PRESETS.devnet, { payer: partner.publicKey, feeClaimer: partner.publicKey, leftoverReceiver: partner.publicKey });
  await sendAndConfirm(client.connection, free, [partner]);
  const launchCost = async (config: typeof built.config, wallet: Keypair) => {
    const start = await client.connection.getBalance(wallet.publicKey);
    const launch = await buildCreateStreamCoinTx(client, { name: "Main", symbol: "MAIN", uri: "https://x.io/m" }, { config, creator: wallet.publicKey });
    await sendAndConfirm(client.connection, launch, [wallet]);
    return start - (await client.connection.getBalance(wallet.publicKey));
  };
  const extra = (await launchCost(built.config, streamer)) - (await launchCost(free.config, freeStreamer));
  assert.equal(extra, Number(solToLamports(String(preset.launchFeeSol))), "a mainnet launch costs exactly 0.05 SOL more");
});
