// Integration test: one stream coin's whole life on Meteora's real DBC program, on a local
// Surfpool chain (offline, with devnet's Meteora programs copied in). Steps run in order and stop at the first failure.
// Run: npm run test:surfpool
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import { buildClaimEarningsTx, unclaimedStreamerFees } from "../../src/lib/dbc/fees";
import { buildGraduateTx } from "../../src/lib/dbc/graduate";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { graduationProgress, loadPoolSnapshot, priceInSol } from "../../src/lib/dbc/pool";
import { COIN_PRESETS, LAUNCH_FEE } from "../../src/lib/dbc/preset";
import { prepareTrade, quoteTrade, type TradeInput } from "../../src/lib/dbc/trade";
import { solToLamports, toBN } from "../../src/lib/dbc/units";
import { stepRunner } from "../support/steps";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { createConfigOwnedBy } from "../../scripts/local-chain/partner-config";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";

const preset = COIN_PRESETS.devnet;
/** Trade sizes as a share of the graduation threshold, so the test fits any preset. */
const ofThreshold = (share: number) => solToLamports((Number(preset.graduationThresholdSol) * share).toFixed(9));
const SLIPPAGE_BPS = 100;
/** Comfortably past the preset's 60-second launch fee schedule. */
const LAUNCH_FEE_WINDOW_SECONDS = 120;
const partner = Keypair.generate();
const streamer = Keypair.generate();
const viewer = Keypair.generate();

let surfnet: Surfnet;
let client: DynamicBondingCurveClient;

before(async () => {
  surfnet = await startOfflineSurfnet([partner, streamer, viewer]);
  client = new DynamicBondingCurveClient(new Connection(surfnet.rpcUrl, "confirmed"), "confirmed");
});

after(() => surfnet?.stop());

test("a stream coin's life: launch, trade, earn, graduate", async (t) => {
  const step = stepRunner(t);
  let config: PublicKey | undefined;
  let mint: PublicKey | undefined;
  let pool: PublicKey | undefined;
  const need = <T>(value: T | undefined, what: string): T => {
    assert.ok(value, `${what} exists`);
    return value;
  };
  const snapshot = () => loadPoolSnapshot(client, need(pool, "pool"));
  const viewerCoins = async () =>
    toBN(
      (await getAccount(client.connection, getAssociatedTokenAddressSync(need(mint, "mint"), viewer.publicKey))).amount,
    );
  const trade = async (input: TradeInput) => {
    const prepared = await prepareTrade(client, await snapshot(), viewer.publicKey, input, SLIPPAGE_BPS);
    await sendAndConfirm(client.connection, prepared, [viewer]);
    return prepared.quote;
  };

  await step("platform creates the config with the preset's threshold", async () => {
    config = (await createConfigOwnedBy(client, preset, partner)).config;

    const onChain = await client.state.getPoolConfig(config);
    assert.ok(onChain);
    assert.equal(onChain.migrationQuoteThreshold.toString(), solToLamports(preset.graduationThresholdSol).toString());
  });

  await step("streamer launches a coin on that config", async () => {
    const built = await buildCreateStreamCoinTx(
      client,
      { name: "Friday Night Ranked", symbol: "FNR", uri: "https://example.com/fnr.json" },
      { config: need(config, "config"), creator: streamer.publicKey },
    );
    await sendAndConfirm(client.connection, built, [streamer]);
    mint = built.mint;

    const found = await client.state.getPoolByBaseMint(mint);
    assert.ok(found);
    assert.ok(found.account.poolState.config.equals(need(config, "config")), "pool uses our config");
    assert.ok(found.account.poolState.creator.equals(streamer.publicKey), "streamer is the creator");
    pool = found.publicKey;
  });

  await step("viewer buys: gets coins; price and progress go up", async () => {
    const before = await snapshot();
    const quote = await trade({ side: "buy", lamports: ofThreshold(0.15) });
    const after = await snapshot();

    assert.ok((await viewerCoins()).gte(quote.minimumAmountOut));
    assert.ok(priceInSol(after) > priceInSol(before), "price went up");
    assert.ok(graduationProgress(after) > 0 && graduationProgress(after) < 1);
    assert.equal(after.status, "trading");
  });

  await step("viewer sells half: gets SOL back; price goes down", async () => {
    const before = await snapshot();
    const solBefore = await client.connection.getBalance(viewer.publicKey);
    await trade({ side: "sell", baseUnits: (await viewerCoins()).divn(2) });

    assert.ok((await client.connection.getBalance(viewer.publicKey)) > solBefore, "SOL went up");
    assert.ok(priceInSol(await snapshot()) < priceInSol(before), "price went down");
  });

  await step("only the streamer can claim; claiming pays out everything earned", async () => {
    const before = await snapshot();
    assert.ok(unclaimedStreamerFees(before).gtn(0), "trades earned the streamer something");
    await assert.rejects(buildClaimEarningsTx(client, before, viewer.publicKey), /Only the coin's streamer/);

    const solBefore = await client.connection.getBalance(streamer.publicKey);
    await sendAndConfirm(client.connection, await buildClaimEarningsTx(client, before, streamer.publicKey), [streamer]);

    assert.ok((await client.connection.getBalance(streamer.publicKey)) > solBefore, "streamer got SOL");
    assert.ok(unclaimedStreamerFees(await snapshot()).isZero(), "nothing left to claim");
  });

  await step("launch fee is ~50%; after a minute it's the 1% base plus a small volatility fee", async () => {
    const probe: TradeInput = { side: "buy", lamports: ofThreshold(0.05) };
    /** Total fee (trading + protocol) as a share of the SOL paid in. Buy fees are taken in SOL. */
    const feeShare = async () => {
      const quote = quoteTrade(await snapshot(), probe, SLIPPAGE_BPS);
      return quote.tradingFee.add(quote.protocolFee).toNumber() / probe.lamports.toNumber();
    };
    const startShare = LAUNCH_FEE.startingFeeBps / 10_000;
    const baseShare = LAUNCH_FEE.endingFeeBps / 10_000;
    const atLaunch = await feeShare();
    assert.ok(Math.abs(atLaunch - startShare) < 0.005, `launch fee ~${startShare * 100}%, got ${(atLaunch * 100).toFixed(2)}%`);

    const now = await client.connection.getBlockTime(await client.connection.getSlot());
    assert.ok(now !== null);
    surfnet.timeTravelToTimestamp((now + LAUNCH_FEE_WINDOW_SECONDS) * 1000);

    // Earlier trades in this test leave some volatility, so allow a small dynamic fee on top.
    const VOLATILITY_MARGIN = 0.0025;
    const settled = await feeShare();
    assert.ok(
      settled >= baseShare - 0.0001 && settled <= baseShare + VOLATILITY_MARGIN,
      `settled fee is the ${baseShare * 100}% base plus at most ${VOLATILITY_MARGIN * 100}%, got ${(settled * 100).toFixed(3)}%`,
    );
  });

  await step("graduating early is refused with a clear reason", async () => {
    await assert.rejects(buildGraduateTx(client, await snapshot(), partner.publicKey), /Coin is trading/);
  });

  await step("an oversized last buy fills only up to the threshold", async () => {
    const asked = ofThreshold(1.5);
    const quote = await trade({ side: "buy", lamports: asked });
    const after = await snapshot();

    assert.ok(quote.spentAmount.lt(asked), "spent less than asked; the rest stays in the wallet");
    assert.equal(after.status, "graduating");
    assert.equal(graduationProgress(after), 1);
    assert.throws(() => quoteTrade(after, { side: "buy", lamports: solToLamports("0.1") }, SLIPPAGE_BPS), /graduating/);
  });

  await step("anyone can graduate the coin into a DAMM v2 pool", async () => {
    await sendAndConfirm(client.connection, await buildGraduateTx(client, await snapshot(), partner.publicKey), [partner]);
    assert.equal((await snapshot()).status, "graduated");
  });
});
