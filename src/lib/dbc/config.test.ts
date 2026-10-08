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

  assert.equal(params.migrationQuoteThreshold.toString(), "1500000000"); // 1.5 SOL
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

test("mainnet preset also validates", () => {
  assert.doesNotThrow(() => buildCreateConfigParams(COIN_PRESETS["mainnet-beta"], accounts));
});
