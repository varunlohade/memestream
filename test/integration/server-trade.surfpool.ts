// Integration test: the server's real trade builder enforces the self-buy rule against chain
// state (the coin's creator), on an offline local chain. Runs with the react-server condition,
// like Next's server, because the server modules are marked server-only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { buildCreateConfigTx } from "../../src/lib/dbc/config";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { COIN_PRESETS } from "../../src/lib/dbc/preset";
import { signatureStatus } from "../../src/lib/tx-status";

const [partner, streamer, viewer] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
let surfnet: Surfnet;
let mint: PublicKey;
let server: typeof import("../../src/server/transactions");
let connection: Connection;

before(async () => {
  surfnet = await startOfflineSurfnet([partner, streamer, viewer]);
  connection = new Connection(surfnet.rpcUrl, "confirmed");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const config = await buildCreateConfigTx(client, COIN_PRESETS.devnet, {
    payer: partner.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
  });
  await sendAndConfirm(client.connection, config, [partner]);
  const launch = await buildCreateStreamCoinTx(client, { name: "Rule", symbol: "RULE", uri: "https://x.io/r" }, { config: config.config, creator: streamer.publicKey });
  await sendAndConfirm(client.connection, launch, [streamer]);
  mint = launch.mint;

  process.env.MEMESTREAM_RPC_URL = surfnet.rpcUrl;
  process.env.MEMESTREAM_CONFIG = config.config.toBase58();
  process.env.MEMESTREAM_PUBLIC_URL = "http://127.0.0.1:3000";
  server = await import("../../src/server/transactions");
});

after(() => surfnet?.stop());

const trade = (wallet: PublicKey, side: "buy" | "sell") =>
  server.buildTradeForWallet({ wallet: wallet.toBase58(), mint: mint.toBase58(), side, amount: "0.1", slippageBps: 100 });

test("the server refuses a buy from the coin's own streamer", async () => {
  await assert.rejects(trade(streamer.publicKey, "buy"), /won't let a streamer's wallet buy their own coin/);
});

test("the server builds a buy for any other wallet", async () => {
  const prepared = await trade(viewer.publicKey, "buy");
  assert.ok(prepared.transaction.length > 0);
  assert.ok(prepared.blockhash.length > 30);
});

// Surfpool's time jumps don't age blockhashes, so real expiry is covered by the real-time
// suite (npm run test:clock). Here: the status logic with a blockhash the chain never issued.
test("an unseen transaction is pending while its blockhash is valid, expired once it isn't", async () => {
  const { default: bs58 } = await import("bs58");
  const neverSent = bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
  const live = (await trade(viewer.publicKey, "buy")).blockhash;
  const neverIssued = Keypair.generate().publicKey.toBase58();
  assert.equal((await signatureStatus(connection, { signature: neverSent, blockhash: live })).status, "pending");
  assert.equal((await signatureStatus(connection, { signature: neverSent, blockhash: neverIssued })).status, "expired");
  assert.equal((await signatureStatus(connection, { signature: null, blockhash: neverIssued })).status, "expired");
});
