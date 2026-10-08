import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { type PoolVaults, tradeFromTransaction } from "./trade-history";

const key = () => Keypair.generate().publicKey;
const trader = key();
const creator = key();
const vaults: PoolVaults = { quote: key(), base: key() };
const pool = { vaults, creator: creator.toBase58() };

/** A transaction signed by `signer` that moves each vault by the given base-unit amounts. */
function txMoving(quoteDelta: number, baseDelta: number, signer = trader, err: unknown = null) {
  const keys = [signer, key(), vaults.quote, vaults.base];
  const balance = (index: number, amount: number) => ({ accountIndex: index, uiTokenAmount: { amount: String(amount) } });
  return {
    blockTime: 1_700_000_000,
    transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
    meta: {
      err,
      preTokenBalances: [balance(2, 5_000_000_000), balance(3, 900_000_000_000)],
      postTokenBalances: [balance(2, 5_000_000_000 + quoteDelta), balance(3, 900_000_000_000 + baseDelta)],
    },
  } as unknown as ParsedTransactionWithMeta;
}

test("SOL into the quote vault is a buy, priced per coin", () => {
  const trade = tradeFromTransaction(txMoving(500_000_000, -1_000_000_000), "sig", pool);
  assert.deepEqual(trade, {
    signature: "sig",
    side: "buy",
    sol: "0.5",
    coins: "1000",
    wallet: trader.toBase58(),
    time: 1_700_000_000,
    priceSol: 0.0005,
    byStreamer: false,
  });
});

test("SOL out of the quote vault is a sell", () => {
  assert.equal(tradeFromTransaction(txMoving(-250_000_000, 2_000_000), "sig", pool)?.side, "sell");
});

test("the streamer's own trades are tagged", () => {
  assert.equal(tradeFromTransaction(txMoving(-1, 1, creator), "sig", pool)?.byStreamer, true);
});

test("transactions that aren't swaps are skipped", () => {
  assert.equal(tradeFromTransaction(null, "sig", pool), null, "not found");
  assert.equal(tradeFromTransaction(txMoving(1, -1, trader, { InstructionError: [0, "Custom"] }), "sig", pool), null, "failed");
  assert.equal(tradeFromTransaction(txMoving(1_000, 0), "sig", pool), null, "only SOL moved (a claim)");
  assert.equal(tradeFromTransaction(txMoving(1, -1), "sig", { ...pool, vaults: { quote: key(), base: vaults.base } }), null, "another pool");
});

test("liquidity moves are not trades: both vaults up (graduation, adding liquidity) or both down", () => {
  assert.equal(tradeFromTransaction(txMoving(100_000_000, 200_000_000_000), "sig", pool), null, "both in");
  assert.equal(tradeFromTransaction(txMoving(-1_000, -5_000), "sig", pool), null, "both out");
});
