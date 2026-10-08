// Slow integration tests (~2.5 min): on a chain whose clock runs in real time (like the dev
// chain and mainnet), with no clock tricks:
// - the launch fee really falls to the base after the first minute;
// - a blockhash really expires, and only then does an unsent transaction read "expired";
// - a transaction that landed still reads "confirmed" after its blockhash has expired.
// Run: npm run test:clock
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { buildCreateConfigTx } from "../../src/lib/dbc/config";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { loadPoolSnapshot } from "../../src/lib/dbc/pool";
import { COIN_PRESETS, LAUNCH_FEE } from "../../src/lib/dbc/preset";
import { quoteTrade, type TradeInput } from "../../src/lib/dbc/trade";
import { solToLamports } from "../../src/lib/dbc/units";
import { pollUntil, sleep } from "../../src/lib/poll";
import { signatureStatus } from "../../src/lib/tx-status";

/** The schedule's full length plus a 10 s margin for block time lag. */
const WAIT_MS = (LAUNCH_FEE.totalDuration + 10) * 1000;
let surfnet: Surfnet | undefined;
after(() => surfnet?.stop());

test("with a real-time clock, the launch fee settles to the base after the first minute", { timeout: WAIT_MS + 60_000 }, async () => {
  const [partner, streamer] = [Keypair.generate(), Keypair.generate()];
  surfnet = await startOfflineSurfnet([partner, streamer], { realTimeClock: true });
  const client = new DynamicBondingCurveClient(new Connection(surfnet.rpcUrl, "confirmed"), "confirmed");

  const config = await buildCreateConfigTx(client, COIN_PRESETS.devnet, {
    payer: partner.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
  });
  await sendAndConfirm(client.connection, config, [partner]);
  const launch = await buildCreateStreamCoinTx(client, { name: "Clock", symbol: "CLK", uri: "https://x.io/c" }, { config: config.config, creator: streamer.publicKey });
  await sendAndConfirm(client.connection, launch, [streamer]);
  const pool = (await client.state.getPoolByBaseMint(launch.mint))?.publicKey as PublicKey;

  const probe: TradeInput = { side: "buy", lamports: solToLamports("0.1") };
  const feeShare = async () => {
    const quote = quoteTrade(await loadPoolSnapshot(client, pool), probe, 100);
    return quote.tradingFee.add(quote.protocolFee).toNumber() / probe.lamports.toNumber();
  };

  const atLaunch = await feeShare();
  assert.ok(atLaunch > LAUNCH_FEE.startingFeeBps / 10_000 - 0.05, `launch fee should be high, got ${(atLaunch * 100).toFixed(2)}%`);

  await sleep(WAIT_MS);

  const base = LAUNCH_FEE.endingFeeBps / 10_000;
  const settled = await feeShare();
  // No trades happened, so there is no volatility fee: exactly the base, within rounding.
  assert.ok(Math.abs(settled - base) < 0.0002, `settled fee should be the ${base * 100}% base, got ${(settled * 100).toFixed(3)}%`);
});

test("a real blockhash expires with time; an unsent transaction reads pending, then expired", { timeout: 180_000 }, async () => {
  const chain = await startOfflineSurfnet([], { realTimeClock: true });
  try {
    const connection = new Connection(chain.rpcUrl, "confirmed");
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const { default: bs58 } = await import("bs58");
    const neverSent = bs58.encode(crypto.getRandomValues(new Uint8Array(64)));

    assert.equal((await signatureStatus(connection, { signature: neverSent, blockhash })).status, "pending");
    const expired = await pollUntil(
      async () => ((await signatureStatus(connection, { signature: neverSent, blockhash })).status === "expired" ? true : undefined),
      { timeoutMs: 150_000, intervalMs: 2_000 },
    );
    assert.ok(expired, "blockhash expired within 150 s of real time");
    assert.equal((await connection.isBlockhashValid(blockhash)).value, false, "the blockhash really is invalid now");
  } finally {
    chain.stop();
  }
});

test("a landed transaction stays 'confirmed' after its blockhash really expires", { timeout: 180_000 }, async () => {
  const payer = Keypair.generate();
  const chain = await startOfflineSurfnet([payer], { realTimeClock: true });
  try {
    const connection = new Connection(chain.rpcUrl, "confirmed");
    const { SystemProgram, Transaction } = await import("@solana/web3.js");
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 }),
    );
    tx.sign(payer);
    const signature = await connection.sendRawTransaction(tx.serialize());
    const landed = await pollUntil(
      async () => ((await signatureStatus(connection, { signature, blockhash })).status === "confirmed" ? true : undefined),
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    assert.ok(landed, "transaction confirmed");

    const gone = await pollUntil(async () => ((await connection.isBlockhashValid(blockhash)).value ? undefined : true), {
      timeoutMs: 150_000,
      intervalMs: 2_000,
    });
    assert.ok(gone, "blockhash expired");
    assert.equal((await signatureStatus(connection, { signature, blockhash })).status, "confirmed");
  } finally {
    chain.stop();
  }
});
