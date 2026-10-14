// Partner fee claims on the real DBC program (offline local chain), mainnet preset: the launch fee
// of every coin and memestream's share of trading fees, claimed in batched transactions by the
// config's fee claimer, with no rent left behind in coin accounts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import { prepareAndSimulate } from "../../scripts/mainnet/common";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { createConfigOwnedBy } from "../../scripts/local-chain/partner-config";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { buildPartnerClaimTxs, loadPartnerFees, PARTNER_CLAIMED_LAUNCH_FEE, partnerLaunchFee } from "../../src/lib/dbc/partner-fees";
import { loadPoolSnapshot } from "../../src/lib/dbc/pool";
import { COIN_PRESETS } from "../../src/lib/dbc/preset";
import { prepareTrade } from "../../src/lib/dbc/trade";
import { solToLamports } from "../../src/lib/dbc/units";

const COINS = 6;
const TRADED = 5;
const [partner, streamer, trader, stranger] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
let surfnet: Surfnet;
let client: DynamicBondingCurveClient;
let config: PublicKey;
const mints: PublicKey[] = [];

before(async () => {
  surfnet = await startOfflineSurfnet([partner, streamer, trader, stranger], { solEach: 40 });
  client = new DynamicBondingCurveClient(new Connection(surfnet.rpcUrl, "confirmed"), "confirmed");
  ({ config } = await createConfigOwnedBy(client, COIN_PRESETS["mainnet-beta"], partner));
  for (let i = 0; i < COINS; i++) {
    const launch = await buildCreateStreamCoinTx(client, { name: `Fee${i}`, symbol: `FEE${i}`, uri: "https://x.io/f" }, { config, creator: streamer.publicKey });
    await sendAndConfirm(client.connection, launch, [streamer]);
    mints.push(launch.mint);
    if (i < TRADED) {
      const pool = (await client.state.getPoolByBaseMint(launch.mint))?.publicKey;
      assert.ok(pool);
      const buy = await prepareTrade(client, await loadPoolSnapshot(client, pool), trader.publicKey, { side: "buy", lamports: solToLamports("0.5") }, 100);
      await sendAndConfirm(client.connection, buy, [trader]);
    }
  }
});
after(() => surfnet?.stop());

test("the fee claimer sees every launch fee and the trading fee share of each traded coin", async () => {
  const fees = await loadPartnerFees(client, config);
  assert.equal(fees.poolCount, COINS);
  assert.equal(fees.pools.length, COINS);
  assert.ok(fees.feeClaimer.equals(partner.publicKey));
  const launchFee = partnerLaunchFee(fees.configState);
  assert.equal(launchFee.toString(), "45000000", "0.05 SOL less Meteora's 10%");
  assert.ok(fees.pools.every((p) => p.launchFeeLamports.eq(launchFee)));
  assert.equal(fees.pools.filter((p) => !p.tradingLamports.isZero()).length, TRADED);
});

test("only the fee claimer can build the claims", async () => {
  const fees = await loadPartnerFees(client, config);
  await assert.rejects(buildPartnerClaimTxs(client, fees, stranger.publicKey), /Only the config's fee claimer/);
});

test("batched claims land, pay the claimer what was listed, and leave nothing to claim or any coin account behind", async () => {
  const fees = await loadPartnerFees(client, config);
  const txs = await buildPartnerClaimTxs(client, fees, partner.publicKey);
  assert.ok(txs.length >= 2, `claims are split across transactions (${txs.length})`);
  assert.equal((await buildPartnerClaimTxs(client, fees, partner.publicKey, 1)).length, 1, "maxTxs caps the batch");

  const start = await client.connection.getBalance(partner.publicKey);
  let networkFees = 0;
  for (const built of txs) {
    const { simulation, priority } = await prepareAndSimulate(client.connection, built.tx);
    assert.ok(simulation.ok, `simulation: ${simulation.error} ${simulation.logs.slice(-3).join(" | ")}`);
    const signature = await sendAndConfirm(client.connection, built, [partner]);
    const meta = await client.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    networkFees += meta?.meta?.fee ?? 0;
    assert.ok(priority.units > 0);
  }
  const gained = (await client.connection.getBalance(partner.publicKey)) - start + networkFees;
  assert.equal(gained, Number(fees.totalLamports.toString()), "exactly the listed fees, no rent kept in token accounts");

  const after = await loadPartnerFees(client, config);
  assert.equal(after.pools.length, 0, "nothing left to claim");
  const pool = (await client.state.getPoolByBaseMint(mints[0]))?.publicKey;
  assert.ok(pool);
  assert.ok(((await client.state.getPool(pool))?.poolState.creationFeeBits ?? 0) & PARTNER_CLAIMED_LAUNCH_FEE, "the launch fee is marked claimed");
  const coinAccounts = mints.map((m) => getAssociatedTokenAddressSync(m, partner.publicKey));
  assert.ok((await client.connection.getMultipleAccountsInfo(coinAccounts)).every((a) => a === null), "the temporary coin accounts were closed");
});

test("101 coins with fees: claims still build, reading at most 100 accounts per call, and only what the batch needs", async () => {
  for (let i = 0; i < 101; i++) {
    const launch = await buildCreateStreamCoinTx(client, { name: `Many${i}`, symbol: `MANY${i}`, uri: "https://x.io/m" }, { config, creator: streamer.publicKey });
    await sendAndConfirm(client.connection, launch, [streamer]);
  }
  const fees = await loadPartnerFees(client, config);
  assert.equal(fees.pools.length, 101, "every new launch fee is claimable");

  const reads: number[] = [];
  const real = client.connection.getMultipleAccountsInfo.bind(client.connection);
  client.connection.getMultipleAccountsInfo = async (keys, config) => {
    assert.ok(keys.length <= 100, `one read of ${keys.length} accounts`);
    reads.push(keys.length);
    return real(keys, config);
  };
  try {
    const one = await buildPartnerClaimTxs(client, fees, partner.publicKey, 1);
    assert.equal(one.length, 1);
    assert.equal(reads.length, 1, "a one-transaction batch reads once");
    const { simulation } = await prepareAndSimulate(client.connection, one[0].tx);
    assert.ok(simulation.ok, `simulation: ${simulation.error}`);

    reads.length = 0;
    const all = await buildPartnerClaimTxs(client, fees, partner.publicKey);
    assert.deepEqual(reads, [100, 1], "all 101 coin accounts, in two reads");
    const claimed = all.reduce((n, b) => n + b.tx.instructions.filter((ix) => ix.programId.equals(client.partner.program.programId)).length, 0);
    assert.equal(claimed, 101, "one launch-fee claim per coin");
  } finally {
    client.connection.getMultipleAccountsInfo = real;
  }
});
