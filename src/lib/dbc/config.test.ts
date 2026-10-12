import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { buildCreateConfigParams } from "./config";
import { COIN_PRESETS } from "./preset";
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
