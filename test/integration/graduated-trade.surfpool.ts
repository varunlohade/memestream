// Integration test: after graduation, the server's own trade builders (previewTrade,
// buildTradeForWallet) quote and trade in the coin's Meteora DAMM v2 pool, with the same money
// rules as before graduation. Offline local chain with the real programs; react-server condition.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, type PublicKey, PublicKey as PublicKeyCtor, Transaction } from "@solana/web3.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { createConfigOwnedBy } from "../../scripts/local-chain/partner-config";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { buildGraduateTx } from "../../src/lib/dbc/graduate";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { loadPoolSnapshot } from "../../src/lib/dbc/pool";
import { COIN_PRESETS } from "../../src/lib/dbc/preset";
import { prepareTrade } from "../../src/lib/dbc/trade";
import { solToLamports } from "../../src/lib/dbc/units";
import { pollUntil } from "../../src/lib/poll";
import { signatureStatus } from "../../src/lib/tx-status";

const [partner, streamer, filler, viewer] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
let surfnet: Surfnet;
let connection: Connection;
let mint: PublicKey;
let server: typeof import("../../src/server/transactions");

before(async () => {
  surfnet = await startOfflineSurfnet([partner, streamer, filler, viewer]);
  connection = new Connection(surfnet.rpcUrl, "confirmed");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const { config } = await createConfigOwnedBy(client, COIN_PRESETS.devnet, partner);
  const launch = await buildCreateStreamCoinTx(client, { name: "Grad", symbol: "GRAD", uri: "https://x.io/g" }, { config, creator: streamer.publicKey });
  await sendAndConfirm(connection, launch, [streamer]);
  mint = launch.mint;

  // Fill the curve (an oversized buy fills only up to the threshold), then graduate.
  const pool = (await client.state.getPoolByBaseMint(mint))?.publicKey;
  assert.ok(pool);
  const fill = await prepareTrade(client, await loadPoolSnapshot(client, pool), filler.publicKey, { side: "buy", lamports: solToLamports("1") }, 100);
  await sendAndConfirm(connection, fill, [filler]);
  await sendAndConfirm(connection, await buildGraduateTx(client, await loadPoolSnapshot(client, pool), partner.publicKey), [partner]);

  process.env.MEMESTREAM_RPC_URL = surfnet.rpcUrl;
  process.env.MEMESTREAM_CONFIG = config.toBase58();
  process.env.MEMESTREAM_PUBLIC_URL = "http://127.0.0.1:3000";
  server = await import("../../src/server/transactions");
});

after(() => surfnet?.stop());

/** Sign a server-built transaction as `wallet`, send it, and wait for its outcome. */
async function signAndSend(prepared: { transaction: string; blockhash: string }, wallet: Keypair) {
  const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  tx.partialSign(wallet);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const outcome = await pollUntil(async () => {
    const result = await signatureStatus(connection, { signature, blockhash: prepared.blockhash });
    return result.status === "pending" ? undefined : result;
  }, { timeoutMs: 30_000, intervalMs: 100 });
  return outcome ?? { status: "pending" as const };
}

const order = (wallet: Keypair, side: "buy" | "sell", amount: string) => ({ wallet: wallet.publicKey.toBase58(), mint: mint.toBase58(), side, amount, slippageBps: 100 });

test("after graduation the server quotes in the Meteora pool: full fills, no partials", async () => {
  const preview = await server.previewTrade(order(viewer, "buy", "0.01"));
  assert.equal(preview.spent, "0.01");
  assert.equal(preview.partial, false);
  assert.ok(Number(preview.received) > 0 && Number(preview.minimumReceived) <= Number(preview.received));
});

test("a viewer buys and then sells a graduated coin through the server", async () => {
  const buy = await server.buildTradeForWallet(order(viewer, "buy", "0.01"));
  assert.equal((await signAndSend(buy, viewer)).status, "confirmed");
  const coins = Number(buy.preview.received);
  const sell = await server.buildTradeForWallet(order(viewer, "sell", (coins / 2).toFixed(6)));
  assert.equal((await signAndSend(sell, viewer)).status, "confirmed");
});

test("the streamer still can't buy their own coin through memestream after graduation", async () => {
  await assert.rejects(server.buildTradeForWallet(order(streamer, "buy", "0.01")), /won't let a streamer's wallet buy their own coin/);
});

test("after graduation a trade still never fills below the minimum the user saw", async () => {
  const seen = await server.previewTrade(order(viewer, "buy", "0.005"));
  assert.equal((await signAndSend(await server.buildTradeForWallet(order(filler, "buy", "0.05")), filler)).status, "confirmed");
  const outcome = await signAndSend(await server.buildTradeForWallet({ ...order(viewer, "buy", "0.005"), minReceived: seen.minimumReceived }), viewer);
  assert.equal(outcome.status, "failed", "the seen minimum makes it fail rather than fill worse");
  // DAMM v2's ExceededSlippage is also 6002, so people read the same "price moved" message.
  assert.match("error" in outcome ? (outcome.error ?? "") : "", /price moved since your quote/);
});

test("a graduated coin shows its Meteora pool, live price and the trades made there", async () => {
  const { getCoinDetail, listCoins } = await import("../../src/server/coins");
  const { dammPriceInSol, loadDammSnapshot } = await import("../../src/lib/damm/pool");
  const detail = await getCoinDetail(mint.toBase58(), viewer.publicKey.toBase58());
  assert.ok(detail?.coin.meteoraPool, "has its Meteora pool");
  assert.equal(detail.coin.status, "graduated");
  const live = await loadDammSnapshot(connection, new PublicKeyCtor(detail.coin.meteoraPool));
  assert.ok(live);
  assert.equal(detail.coin.priceSol, dammPriceInSol(live.state), "price is the pool's, not the frozen curve's");
  assert.ok(detail.trades.some((t) => t.wallet === viewer.publicKey.toBase58() && t.side === "buy"), "the viewer's pool buy shows");
  assert.ok(detail.trades.some((t) => t.wallet === viewer.publicKey.toBase58() && t.side === "sell"), "the viewer's pool sell shows");

  const listed = (await listCoins()).find((c) => c.mint === mint.toBase58());
  assert.equal(listed?.meteoraPool, detail.coin.meteoraPool);
  assert.equal(listed?.priceSol, detail.coin.priceSol);
});

test("the streamer sees their LP NFT's pool fees and claims them; a viewer can't", async () => {
  const { getCoinDetail } = await import("../../src/server/coins");
  const streamerView = await getCoinDetail(mint.toBase58(), streamer.publicKey.toBase58());
  assert.ok(streamerView?.holdings?.lpFees, "the streamer holds an LP position");
  assert.ok(Number(streamerView.holdings.lpFees.sol) > 0, "pool trades earned it SOL");
  const viewerView = await getCoinDetail(mint.toBase58(), viewer.publicKey.toBase58());
  assert.equal(viewerView?.holdings?.lpFees, null, "a viewer holds no LP position");

  await assert.rejects(server.buildClaimPoolFeesForWallet({ wallet: viewer.publicKey.toBase58(), mint: mint.toBase58() }), /no LP position/);
  const before = await connection.getBalance(streamer.publicKey);
  const claim = await server.buildClaimPoolFeesForWallet({ wallet: streamer.publicKey.toBase58(), mint: mint.toBase58() });
  assert.equal((await signAndSend(claim, streamer)).status, "confirmed");
  // Net of the network fee, the streamer gains the fees: no rent left behind in an empty coin account.
  const gained = (await connection.getBalance(streamer.publicKey)) - before;
  const fees = Number(solToLamports(streamerView.holdings.lpFees.sol));
  assert.ok(gained > fees - 10_000 && gained <= fees, `gained ${gained} lamports for ${fees} lamports of fees`);
});

test("the platform's (partner's) LP NFT exists after graduation and the partner's claim pays it", async () => {
  const { getCoinDetail } = await import("../../src/server/coins");
  const view = await getCoinDetail(mint.toBase58(), partner.publicKey.toBase58());
  assert.ok(view?.holdings?.lpFees, "graduation gave the partner an LP position");
  const fees = Number(solToLamports(view.holdings.lpFees.sol));
  assert.ok(fees > 0);
  const before = await connection.getBalance(partner.publicKey);
  const claim = await server.buildClaimPoolFeesForWallet({ wallet: partner.publicKey.toBase58(), mint: mint.toBase58() });
  assert.equal((await signAndSend(claim, partner)).status, "confirmed");
  const gained = (await connection.getBalance(partner.publicKey)) - before;
  assert.ok(gained > fees - 10_000 && gained <= fees, `partner gained ${gained} lamports for ${fees} of fees`);
});

test("graduation itself (filling the new pool) never shows as a trade", async () => {
  const { getCoinDetail } = await import("../../src/server/coins");
  await new Promise((r) => setTimeout(r, 4_100)); // past the coin-detail cache
  const detail = await getCoinDetail(mint.toBase58(), null);
  assert.ok(detail);
  assert.ok(!detail.trades.some((t) => t.wallet === partner.publicKey.toBase58()), "the graduating wallet made no trade");
});
