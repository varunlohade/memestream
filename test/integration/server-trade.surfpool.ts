// Integration test: the server's real trade builder enforces the self-buy rule against chain
// state (the coin's creator), on an offline local chain. Runs with the react-server condition,
// like Next's server, because the server modules are marked server-only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Surfnet } from "@solana/surfpool";
import { ComputeBudgetProgram, Connection, Keypair, type PublicKey, Transaction } from "@solana/web3.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { createConfigOwnedBy } from "../../scripts/local-chain/partner-config";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { COIN_PRESETS } from "../../src/lib/dbc/preset";
import { pollUntil } from "../../src/lib/poll";
import { DEFAULT_PRIORITY_FEE } from "../../src/lib/priority-fee";
import { signatureStatus } from "../../src/lib/tx-status";
import { neverSentSignature } from "../support/signatures";

const [partner, streamer, viewer] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
let surfnet: Surfnet;
let mint: PublicKey;
let server: typeof import("../../src/server/transactions");
let connection: Connection;

before(async () => {
  surfnet = await startOfflineSurfnet([partner, streamer, viewer]);
  connection = new Connection(surfnet.rpcUrl, "confirmed");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const { config } = await createConfigOwnedBy(client, COIN_PRESETS.devnet, partner);
  const launch = await buildCreateStreamCoinTx(client, { name: "Rule", symbol: "RULE", uri: "https://x.io/r" }, { config, creator: streamer.publicKey });
  await sendAndConfirm(client.connection, launch, [streamer]);
  mint = launch.mint;

  process.env.MEMESTREAM_RPC_URL = surfnet.rpcUrl;
  process.env.MEMESTREAM_CONFIG = config.toBase58();
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
  const neverSent = neverSentSignature();
  const live = (await trade(viewer.publicKey, "buy")).blockhash;
  const neverIssued = Keypair.generate().publicKey.toBase58();
  assert.equal((await signatureStatus(connection, { signature: neverSent, blockhash: live })).status, "pending");
  assert.equal((await signatureStatus(connection, { signature: neverSent, blockhash: neverIssued })).status, "expired");
  assert.equal((await signatureStatus(connection, { signature: null, blockhash: neverIssued })).status, "expired");
});

test("a landed buy shows in the coin's trades and the buyer's holdings", async () => {
  const prepared = await server.buildTradeForWallet({ wallet: viewer.publicKey.toBase58(), mint: mint.toBase58(), side: "buy", amount: "0.01", slippageBps: 100 });
  const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  tx.partialSign(viewer);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const landed = await pollUntil(
    async () => ((await signatureStatus(connection, { signature, blockhash: prepared.blockhash })).status === "confirmed" ? true : undefined),
    { timeoutMs: 30_000, intervalMs: 100 },
  );
  assert.ok(landed, "buy confirmed");

  const { getCoinDetail } = await import("../../src/server/coins");
  const detail = await getCoinDetail(mint.toBase58(), viewer.publicKey.toBase58());
  assert.equal(detail?.coin.symbol, "RULE");
  assert.deepEqual(
    detail?.trades.map((t) => [t.signature, t.side, t.wallet, t.byStreamer]),
    [[signature, "buy", viewer.publicKey.toBase58(), false]],
  );
  assert.equal(detail?.trades[0].coins, prepared.preview.received);
  assert.ok(Number(detail?.holdings?.coins) > 0, "the buyer holds coins");
});

/** Sign a server-built transaction as `wallet`, send it, and read its outcome (status and error). */
async function sendAndRead(prepared: { transaction: string; blockhash: string }, wallet: Keypair) {
  const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  tx.partialSign(wallet);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 100; i++) {
    const result = await signatureStatus(connection, { signature, blockhash: prepared.blockhash });
    if (result.status !== "pending") return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { status: "pending" as const };
}
const signAndSend = async (prepared: { transaction: string; blockhash: string }, wallet: Keypair) => (await sendAndRead(prepared, wallet)).status;

test("a price move after the preview makes the trade fail, never fill worse than the user saw", async () => {
  const order = { wallet: viewer.publicKey.toBase58(), mint: mint.toBase58(), side: "buy" as const, amount: "0.005", slippageBps: 100 };
  const seen = await server.previewTrade(order);

  // Someone else buys first: the price goes up, so the same SOL now buys fewer coins.
  assert.equal(await signAndSend(await server.buildTradeForWallet({ ...order, wallet: partner.publicKey.toBase58(), amount: "0.03" }), partner), "confirmed");

  const withSeenMinimum = await server.buildTradeForWallet({ ...order, minReceived: seen.minimumReceived });
  const outcome = await sendAndRead(withSeenMinimum, viewer);
  assert.equal(outcome.status, "failed", "the trade must not fill below what the user saw");
  // Specifically DBC 6002 ExceededSlippage (worded for people by describeTxError), not some other failure.
  assert.match(outcome.error ?? "", /price moved since your quote/);

  // Without the seen minimum the server's fresh quote applies, and the trade goes through.
  assert.equal(await signAndSend(await server.buildTradeForWallet(order), viewer), "confirmed");
});

test("a lower client minimum can't loosen the server's own slippage floor", async () => {
  const order = { wallet: viewer.publicKey.toBase58(), mint: mint.toBase58(), side: "buy" as const, amount: "0.005", slippageBps: 100 };
  const strict = await server.buildTradeForWallet(order);
  const loose = await server.buildTradeForWallet({ ...order, minReceived: "0.000001" });
  assert.equal(loose.preview.minimumReceived, strict.preview.minimumReceived);
  await assert.rejects(server.buildTradeForWallet({ ...order, minReceived: "abc" }), /Not a valid minimum amount/);
});

/** The Compute Budget instructions of a server-built transaction: [unit limit, unit price]. */
function budgetOf(prepared: { transaction: string }) {
  const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  const budget = tx.instructions.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
  assert.equal(budget.length, 2, "exactly one unit limit and one unit price");
  assert.ok(budget[0] === tx.instructions[0] && budget[1] === tx.instructions[1], "they come first");
  return { units: tx.instructions[0].data.readUInt32LE(1), microLamports: Number(tx.instructions[1].data.readBigUInt64LE(1)) };
}

test("every server-built transaction carries a priority fee, and launch, buy, sell and graduate still land with it", async () => {
  // The local chain reports no recent fees, so the price is the floor; the limit comes from simulation.
  const buy = await server.buildTradeForWallet({ wallet: viewer.publicKey.toBase58(), mint: mint.toBase58(), side: "buy", amount: "0.01", slippageBps: 100 });
  const { units, microLamports } = budgetOf(buy);
  assert.equal(microLamports, DEFAULT_PRIORITY_FEE.minMicroLamports);
  assert.ok(units > 10_000 && units < DEFAULT_PRIORITY_FEE.fallbackUnits, `limit from simulation, not the fallback (${units})`);
  assert.equal(await signAndSend(buy, viewer), "confirmed");

  // The cap from env holds even when it's below the floor.
  process.env.MEMESTREAM_PRIORITY_FEE_MAX = "5000";
  try {
    const capped = await server.buildTradeForWallet({ wallet: viewer.publicKey.toBase58(), mint: mint.toBase58(), side: "sell", amount: "1000", slippageBps: 100 });
    assert.equal(budgetOf(capped).microLamports, 5_000);
    assert.equal(await signAndSend(capped, viewer), "confirmed", "a sell lands");
  } finally {
    delete process.env.MEMESTREAM_PRIORITY_FEE_MAX;
  }

  // A launch through the server (the fresh mint keypair signs after the budget went in).
  const launch = await server.buildLaunchForWallet({ wallet: streamer.publicKey.toBase58(), name: "Prio", symbol: "PRIO", streamUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  budgetOf(launch);
  assert.equal(await signAndSend(launch, streamer), "confirmed", "a launch lands");

  // Fill the 0.1 SOL devnet curve, then graduate through the server (two position NFT keypairs).
  const fill = await server.buildTradeForWallet({ wallet: viewer.publicKey.toBase58(), mint: launch.mint, side: "buy", amount: "1", slippageBps: 100 });
  assert.equal(await signAndSend(fill, viewer), "confirmed");
  const graduate = await server.buildGraduateForWallet({ wallet: partner.publicKey.toBase58(), mint: launch.mint });
  budgetOf(graduate);
  assert.equal(await signAndSend(graduate, partner), "confirmed", "graduation lands");
});
