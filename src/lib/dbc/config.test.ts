import assert from "node:assert/strict";
import { test } from "node:test";
import { MigrationFeeOption, MigrationOption } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair } from "@solana/web3.js";
import { buildCreateConfigParams } from "./config";
import { describeConfig } from "./config-summary";
import { COIN_PRESETS, MAINNET_PARTNER_WALLET } from "./preset";
import { QUOTE } from "./units";

const key = () => Keypair.generate().publicKey;
const accounts = { config: key(), payer: key(), feeClaimer: key(), leftoverReceiver: key() };

test("devnet preset builds a config that passes the SDK validator", () => {
  const params = buildCreateConfigParams(COIN_PRESETS.devnet, accounts);

  assert.equal(params.migrationQuoteThreshold.toString(), "100000000"); // 0.1 SOL: tiny, so devnet testers graduate with faucet SOL
  assert.equal(params.creatorTradingFeePercentage, 80);
  assert.equal(params.quoteMint.toString(), QUOTE.mint.toBase58());
  assert.equal(params.tokenSupply?.preMigrationTokenSupply.toString(), "1000000000000000"); // 1B × 10^6
});

test("all graduated liquidity is locked forever", () => {
  const p = buildCreateConfigParams(COIN_PRESETS.devnet, accounts);
  const locked = p.partnerPermanentLockedLiquidityPercentage + p.creatorPermanentLockedLiquidityPercentage;
  const unlocked = p.partnerLiquidityPercentage + p.creatorLiquidityPercentage;
  assert.equal(locked, 100);
  assert.equal(unlocked, 0);
});

test("mainnet preset validates and graduates at 3 SOL (the owner's number)", () => {
  const params = buildCreateConfigParams(COIN_PRESETS["mainnet-beta"], accounts);
  assert.equal(params.migrationQuoteThreshold.toString(), "3000000000"); // 3 SOL
  assert.equal(params.poolCreationFee.toString(), "50000000"); // 0.05 SOL launch fee
  // All graduated liquidity to the streamer, locked forever.
  assert.equal(params.creatorPermanentLockedLiquidityPercentage, 100);
  assert.equal(params.partnerPermanentLockedLiquidityPercentage, 0);
  assert.equal(params.creatorLiquidityPercentage + params.partnerLiquidityPercentage, 0, "nothing unlocked");
});

test("devnet keeps the 50/50 locked split its existing config was created with", () => {
  const params = buildCreateConfigParams(COIN_PRESETS.devnet, accounts);
  assert.equal(params.partnerPermanentLockedLiquidityPercentage, 50);
  assert.equal(params.creatorPermanentLockedLiquidityPercentage, 50);
});

test("devnet launches stay free (the devnet config already exists with 0)", () => {
  assert.equal(buildCreateConfigParams(COIN_PRESETS.devnet, accounts).poolCreationFee.toString(), "0");
});

test("mainnet fee settings are the owner's (2026-10-15): 50% to 1% over 60 s, dynamic fee, 80% to the streamer, 1% graduated pool", () => {
  const params = buildCreateConfigParams(COIN_PRESETS["mainnet-beta"], accounts);
  const { baseFee, dynamicFee } = params.poolFees;
  assert.equal(baseFee.cliffFeeNumerator.toString(), "500000000", "50% at launch");
  assert.equal(baseFee.firstFactor, 60, "60 steps");
  assert.equal(baseFee.secondFactor.toString(), "1", "of 1 s each");
  assert.equal(baseFee.cliffFeeNumerator.sub(baseFee.thirdFactor.muln(60)).divn(100_000).toString(), "100", "ends at 1% (100 bps)");
  assert.ok(dynamicFee, "volatility fee on");
  assert.equal(params.creatorTradingFeePercentage, 80);
  assert.equal(params.migrationFeeOption, MigrationFeeOption.FixedBps100);
  assert.equal(params.migrationOption, MigrationOption.MET_DAMM_V2);
});

test("the mainnet partner wallet is the owner's", () => {
  assert.equal(MAINNET_PARTNER_WALLET, "BxfZSzPDJVRyPrBQVDEJzgonQgHeVXJU34FAf2MQ6Enf");
});

test("the dry-run summary says the key numbers in plain words", () => {
  const params = buildCreateConfigParams(COIN_PRESETS["mainnet-beta"], accounts);
  const lines = new Map(describeConfig(params));
  assert.equal(lines.get("Graduation threshold"), "3 SOL in the curve");
  assert.match(lines.get("Launch fee per coin (pool creation fee)") ?? "", /^0\.05 SOL \(memestream gets 0\.045 SOL/);
  assert.match(lines.get("Launch fee schedule") ?? "", /^50% at launch, falling in 60 steps of 1 s to 1\.00%/);
  assert.equal(lines.get("Graduated pool fee"), "FixedBps100");
  assert.equal(lines.get("Graduates to"), "MET_DAMM_V2");
  assert.equal(lines.get("Graduated liquidity"), "streamer 100% locked forever + 0% unlocked; memestream 0% locked + 0% unlocked");
  assert.equal(lines.get("Fee claimer (memestream's fee share and launch fees)"), accounts.feeClaimer.toBase58());
  assert.equal(lines.get("Creator vesting"), "none");
});
