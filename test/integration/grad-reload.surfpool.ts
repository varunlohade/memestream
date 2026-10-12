// Integration test: a coin page loaded the moment graduation lands (no earlier read cached on this
// server) shows the graduated coin, never "not found". Offline local chain with the real programs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair } from "@solana/web3.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { createConfigOwnedBy } from "../../scripts/local-chain/partner-config";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { buildGraduateTx } from "../../src/lib/dbc/graduate";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { loadPoolSnapshot } from "../../src/lib/dbc/pool";
import { COIN_PRESETS } from "../../src/lib/dbc/preset";
import { prepareTrade } from "../../src/lib/dbc/trade";
import { solToLamports } from "../../src/lib/dbc/units";

const [partner, streamer, filler] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
let surfnet: Surfnet;

before(async () => {
  surfnet = await startOfflineSurfnet([partner, streamer, filler]);
});
after(() => surfnet?.stop());

test("a coin loaded right after it graduates shows as graduated with its Meteora pool", async () => {
  const connection = new Connection(surfnet.rpcUrl, "confirmed");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const { config } = await createConfigOwnedBy(client, COIN_PRESETS.devnet, partner);
  const launch = await buildCreateStreamCoinTx(client, { name: "Fresh", symbol: "FRESH", uri: "https://x.io/f" }, { config, creator: streamer.publicKey });
  await sendAndConfirm(connection, launch, [streamer]);
  const pool = (await client.state.getPoolByBaseMint(launch.mint))?.publicKey;
  assert.ok(pool);
  const fill = await prepareTrade(client, await loadPoolSnapshot(client, pool), filler.publicKey, { side: "buy", lamports: solToLamports("1") }, 100);
  await sendAndConfirm(connection, fill, [filler]);
  await sendAndConfirm(connection, await buildGraduateTx(client, await loadPoolSnapshot(client, pool), partner.publicKey), [partner]);

  process.env.MEMESTREAM_RPC_URL = surfnet.rpcUrl;
  process.env.MEMESTREAM_CONFIG = config.toBase58();
  process.env.MEMESTREAM_PUBLIC_URL = "http://127.0.0.1:3000";
  const { getCoinDetail } = await import("../../src/server/coins");
  const detail = await getCoinDetail(launch.mint.toBase58(), null);
  assert.equal(detail?.coin.status, "graduated");
  assert.ok(detail.coin.meteoraPool, "has its Meteora pool");
});
