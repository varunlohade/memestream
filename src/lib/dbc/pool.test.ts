import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolConfig, VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { graduationProgress, priceInSol, statusOf, toPoolView } from "./pool";
import { BASE_DECIMALS, solToLamports } from "./units";

const key = () => Keypair.generate().publicKey;
const config = {
  tokenDecimal: BASE_DECIMALS,
  preMigrationTokenSupply: new BN("1000000000000000"), // 1B coins
  migrationQuoteThreshold: solToLamports("10"),
} as unknown as PoolConfig;

/** A pool holding `raisedSol` in its curve, priced at sqrtPrice 2^64 (1 base unit = 1 lamport). */
const poolWith = (raisedSol: string, isMigrated = 0) =>
  ({
    poolState: {
      sqrtPrice: new BN(1).shln(64),
      baseMint: key(),
      creator: key(),
      quoteReserve: solToLamports(raisedSol),
      creatorQuoteFee: solToLamports("0.25"),
      activationPoint: new BN(1_700_000_000),
      isMigrated,
    },
  }) as unknown as VirtualPool;

test("status follows the curve: trading, graduating at the threshold, graduated once migrated", () => {
  assert.equal(statusOf(poolWith("9.99"), config), "trading");
  assert.equal(statusOf(poolWith("10"), config), "graduating");
  assert.equal(statusOf(poolWith("10", 1), config), "graduated");
});

test("progress is the threshold share, capped at 1", () => {
  assert.equal(graduationProgress({ pool: poolWith("0"), config }), 0);
  assert.equal(graduationProgress({ pool: poolWith("2.5"), config }), 0.25);
  assert.equal(graduationProgress({ pool: poolWith("12"), config }), 1);
});

test("the pool view prices the coin and caps raised SOL at the threshold", () => {
  const pool = poolWith("12");
  const view = toPoolView({ address: key(), pool, config });
  assert.equal(view.priceSol, priceInSol({ pool, config }));
  assert.equal(view.marketCapSol, view.priceSol * 1_000_000_000);
  assert.equal(view.raisedSol, "10");
  assert.equal(view.thresholdSol, "10");
  assert.equal(view.streamerUnclaimedSol, "0.25");
  assert.equal(view.launchedAt, 1_700_000_000);
});
