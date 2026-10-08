// Integration test: one stream coin's whole life on Meteora's real DBC program, on a local
// Surfpool chain (offline, with devnet's Meteora programs copied in). Steps run in order and stop at the first failure.
// Run: npm run test:surfpool
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import { buildClaimEarningsTx, unclaimedStreamerFees } from "../../src/lib/dbc/fees";
import { buildGraduateTx } from "../../src/lib/dbc/graduate";
import { buildCreateStreamCoinTx } from "../../src/lib/dbc/launch";
import { graduationProgress, loadPoolSnapshot, priceInSol } from "../../src/lib/dbc/pool";
import { COIN_PRESETS, LAUNCH_FEE } from "../../src/lib/dbc/preset";
import { prepareTrade, quoteTrade, type TradeInput } from "../../src/lib/dbc/trade";
import { QUOTE, solToLamports, toBN } from "../../src/lib/dbc/units";
import { dammPriceInSol, graduatedPoolAddress, loadDammSnapshot } from "../../src/lib/damm/pool";
import { prepareDammTrade, quoteDammTrade } from "../../src/lib/damm/trade";
import { buildClaimPoolFeesTx, lpPositionsOf, unclaimedPoolFees } from "../../src/lib/damm/positions";
import { buyFeeShare, shareOfBps } from "../support/fees";
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
    const feeShare = async () => buyFeeShare(quoteTrade(await snapshot(), probe, SLIPPAGE_BPS), probe.lamports);
    const startShare = shareOfBps(LAUNCH_FEE.startingFeeBps);
    const baseShare = shareOfBps(LAUNCH_FEE.endingFeeBps);
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

  // After graduation the coin trades in its DAMM v2 pool, found from the mint alone.
  let dammPool: PublicKey | undefined;
  const damm = async () => need((await loadDammSnapshot(client.connection, need(dammPool, "DAMM pool"))) ?? undefined, "DAMM pool state");
  const dammTrade = async (input: TradeInput, atLeast?: BN) => {
    const prepared = await prepareDammTrade(client.connection, await damm(), viewer.publicKey, input, SLIPPAGE_BPS, atLeast);
    await sendAndConfirm(client.connection, prepared, [viewer]);
    return prepared.quote;
  };

  await step("the graduated pool is found from the mint: coin is token A, SOL is token B", async () => {
    const poolConfig = need((await client.state.getPoolConfig(need(config, "config"))) ?? undefined, "config state");
    dammPool = graduatedPoolAddress(poolConfig, need(mint, "mint"));
    const { state } = await damm();
    assert.ok(state.tokenAMint.equals(need(mint, "mint")));
    assert.ok(state.tokenBMint.equals(QUOTE.mint));
    assert.ok(dammPriceInSol(state) > 0);
  });

  await step("after graduation a viewer buys and sells in the Meteora pool", async () => {
    const coinsBefore = await viewerCoins();
    const priceBefore = dammPriceInSol((await damm()).state);
    const bought = await dammTrade({ side: "buy", lamports: ofThreshold(0.05) });
    assert.ok((await viewerCoins()).sub(coinsBefore).gte(bought.minimumAmountOut), "got at least the minimum");
    assert.ok(dammPriceInSol((await damm()).state) > priceBefore, "price went up");

    const solBefore = await client.connection.getBalance(viewer.publicKey);
    await dammTrade({ side: "sell", baseUnits: (await viewerCoins()).divn(2) });
    assert.ok((await client.connection.getBalance(viewer.publicKey)) > solBefore, "SOL went up");
  });

  await step("after graduation too, a trade never fills below the minimum the user saw", async () => {
    const input: TradeInput = { side: "buy", lamports: ofThreshold(0.02) };
    const seen = quoteDammTrade(await damm(), input, SLIPPAGE_BPS);
    await dammTrade({ side: "buy", lamports: ofThreshold(0.1) }); // someone else moves the price up first
    await assert.rejects(dammTrade(input, seen.minimumAmountOut), /failed/i, "the seen minimum makes it fail");
    await dammTrade(input); // the fresh quote's own floor goes through
  });

  await step("the streamer's LP NFT earned pool fees; only its holder can claim them", async () => {
    const pool = need(dammPool, "DAMM pool");
    const { state } = await damm();
    const streamerLp = await lpPositionsOf(client.connection, pool, streamer.publicKey);
    assert.equal(streamerLp.length, 1, "graduation gave the streamer one position NFT");
    assert.ok(unclaimedPoolFees(state, streamerLp).lamports.gtn(0), "the pool trades earned it SOL fees");
    assert.equal((await lpPositionsOf(client.connection, pool, viewer.publicKey)).length, 0);
    await assert.rejects(buildClaimPoolFeesTx(client.connection, { address: pool, state }, viewer.publicKey, []), /no LP position/);

    const solBefore = await client.connection.getBalance(streamer.publicKey);
    await sendAndConfirm(client.connection, await buildClaimPoolFeesTx(client.connection, { address: pool, state }, streamer.publicKey, streamerLp), [streamer]);
    assert.ok((await client.connection.getBalance(streamer.publicKey)) > solBefore, "streamer got SOL");
    const after = await lpPositionsOf(client.connection, pool, streamer.publicKey);
    assert.ok(unclaimedPoolFees((await damm()).state, after).lamports.isZero(), "nothing left to claim");
    await assert.rejects(buildClaimPoolFeesTx(client.connection, { address: pool, state: (await damm()).state }, streamer.publicKey, after), /No pool fees/);
  });
});
