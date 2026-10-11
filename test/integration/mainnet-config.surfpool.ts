// The MAINNET preset on the real DBC program (offline local chain): the config is accepted with a
// 3 SOL threshold and a 0.05 SOL launch fee, launching a coin actually charges that fee, and
// graduation gives all locked liquidity to the streamer.
// Mainnet config params are fixed forever once created, so they're proven here first.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Surfnet } from "@solana/surfpool";
import { CpAmm, positionByPoolFilter } from "@meteora-ag/cp-amm-sdk";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { buildCreateConfigTx } from "../../src/lib/dbc/config";
import { buildGraduateTx } from "../../src/lib/dbc/graduate";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { loadPoolSnapshot } from "../../src/lib/dbc/pool";
import { prepareTrade } from "../../src/lib/dbc/trade";
import { graduatedPoolAddress } from "../../src/lib/damm/pool";
import { lpPositionsOf } from "../../src/lib/damm/positions";
import { COIN_PRESETS } from "../../src/lib/dbc/preset";
import { solToLamports } from "../../src/lib/dbc/units";

const preset = COIN_PRESETS["mainnet-beta"];
const [partner, streamer, freeStreamer, whale] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
let surfnet: Surfnet;
let client: DynamicBondingCurveClient;

before(async () => {
  surfnet = await startOfflineSurfnet([partner, streamer, freeStreamer, whale], { solEach: 40 });
  client = new DynamicBondingCurveClient(new Connection(surfnet.rpcUrl, "confirmed"), "confirmed");
});
after(() => surfnet?.stop());

test("the mainnet preset creates a config with a 3 SOL threshold and a 0.05 SOL launch fee", async () => {
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
  mainnetConfig = built.config;
});

let mainnetConfig: PublicKey | undefined;

test("on mainnet settings, graduation gives 100% of the locked liquidity to the streamer: one position NFT, theirs", async () => {
  assert.ok(mainnetConfig, "config from the previous test");
  const launch = await buildCreateStreamCoinTx(client, { name: "Grad", symbol: "GRAD", uri: "https://x.io/g" }, { config: mainnetConfig, creator: streamer.publicKey });
  await sendAndConfirm(client.connection, launch, [streamer]);
  const pool = (await client.state.getPoolByBaseMint(launch.mint))?.publicKey;
  assert.ok(pool);
  // Fill the 3 SOL curve, then graduate. Right after launch the anti-sniper fee is 50%, so buy
  // well over 2x the threshold; an oversized buy fills only up to it and the rest stays in the wallet.
  const fill = await prepareTrade(client, await loadPoolSnapshot(client, pool), whale.publicKey, { side: "buy", lamports: solToLamports("10") }, 100);
  await sendAndConfirm(client.connection, fill, [whale]);
  const snapshot = await loadPoolSnapshot(client, pool);
  assert.equal(snapshot.status, "graduating");
  await sendAndConfirm(client.connection, await buildGraduateTx(client, snapshot, partner.publicKey), [partner]);

  const damm = graduatedPoolAddress(snapshot.config, launch.mint);
  const inPool = await new CpAmm(client.connection)._program.account.position.all([positionByPoolFilter(damm)]);
  assert.equal(inPool.length, 1, "exactly one LP position exists in the graduated pool");
  assert.equal((await lpPositionsOf(client.connection, damm, streamer.publicKey)).length, 1, "and the streamer holds it");
  assert.equal((await lpPositionsOf(client.connection, damm, partner.publicKey)).length, 0, "the platform holds none");
});
