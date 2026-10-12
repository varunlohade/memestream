// Integration test: a prediction market's full life on an offline local chain with the real
// programs (MetaDAO conditional vault + Meteora DAMM v2), in the FPMM design: one YES/NO pool, bets
// split SOL and swap, so any size fills. Create and seed, bet big, buy and sell back, close trading,
// resolve, redeem. Plus the refund path, where every share pays half.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { getAmountAFromLiquidityDelta, getAmountBFromLiquidityDelta, MAX_SQRT_PRICE, MIN_SQRT_PRICE, Rounding } from "@meteora-ag/cp-amm-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { solToLamports } from "../../src/lib/dbc/units";
import { buildCreateMarketTxs, buildMarketMetadataTx } from "../../src/lib/markets/create";
import { fpmmBuyAmount, payoutNumerators, redeemLamports } from "../../src/lib/markets/math";
import { loadMarketPool, MARKET_FEE_BPS, type MarketKeys, marketKeys, marketOdds, type MarketPool, verifyMarketPool } from "../../src/lib/markets/pool";
import { positionNftFor } from "../../src/lib/markets/provenance";
import { buildCloseTradingTxs, buildRedeemTx, buildResolveTx } from "../../src/lib/markets/settle";
import { type MarketOrder, prepareMarketTrade, quoteMarketTrade } from "../../src/lib/markets/trade";
import { pollUntil } from "../../src/lib/poll";
import { signatureStatus } from "../../src/lib/tx-status";
import { stepRunner } from "../support/steps";

const [oracle, alice, bob] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const coinMint = Keypair.generate().publicKey;
const SECRET = randomBytes(32).toString("hex");
const SEED = solToLamports("0.5");
const NAMES = {
  yes: { name: "TEST #1 YES", symbol: "YES", uri: "https://memestream.lol/m/yes.json" },
  no: { name: "TEST #1 NO", symbol: "NO", uri: "https://memestream.lol/m/no.json" },
};

let surfnet: Surfnet;
let connection: Connection;

before(async () => {
  surfnet = await startOfflineSurfnet([oracle, alice, bob]);
  connection = new Connection(surfnet.rpcUrl, "confirmed");
});

after(() => surfnet?.stop());

const balance = (wallet: Keypair) => connection.getBalance(wallet.publicKey);
const tokenBalance = async (keys: MarketKeys, side: "yes" | "no", wallet: Keypair) => {
  const amount = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(keys.mints[side], wallet.publicKey)).catch(() => null);
  return BigInt(amount?.value.amount ?? "0");
};
const vaultLamports = async (keys: MarketKeys) =>
  BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(NATIVE_MINT, keys.vault, true))).value.amount);
const pool = async (keys: MarketKeys) => {
  const loaded = await loadMarketPool(connection, keys);
  assert.ok(loaded, "the pool exists");
  return loaded;
};
const sumsToOne = (p: MarketPool) => {
  const { yes, no } = marketOdds(p).probability;
  assert.ok(Math.abs(yes + no - 1) < 1e-12, `YES ${yes} + NO ${no} = 1`);
  return yes;
};

/** Sign a server-built transaction as `wallet`, send it, and wait for its outcome. */
async function signAndSend(prepared: { transaction: string; blockhash: string }, wallet: Keypair) {
  const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  tx.partialSign(wallet);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const outcome = await pollUntil(async () => {
    const result = await signatureStatus(connection, { signature, blockhash: prepared.blockhash });
    return result.status === "pending" ? undefined : result;
  }, { timeoutMs: 30_000, intervalMs: 100 });
  return outcome?.status ?? "pending";
}

async function createMarket(predictionId: string): Promise<{ keys: MarketKeys; pool: MarketPool }> {
  const keys = marketKeys(connection, SECRET, coinMint, predictionId, oracle.publicKey);
  for (const tx of await buildCreateMarketTxs(connection, keys, SEED, positionNftFor(SECRET, keys.questionId))) await sendAndConfirm(connection, tx, [oracle]);
  await sendAndConfirm(connection, await buildMarketMetadataTx(connection, keys, NAMES), [oracle]);
  return { keys, pool: await pool(keys) };
}

async function trade(keys: MarketKeys, wallet: Keypair, order: MarketOrder) {
  const built = await prepareMarketTrade(connection, keys, await pool(keys), wallet.publicKey, order, 100);
  await sendAndConfirm(connection, built, [wallet]);
  return built.quote;
}

async function closeAndResolve(keys: MarketKeys, outcome: "yes" | "no" | "refund") {
  const closes = await buildCloseTradingTxs(connection, keys, await pool(keys));
  assert.equal(closes.length, 1, "one close for the one pool");
  for (const tx of closes) await sendAndConfirm(connection, tx, [oracle]);
  await sendAndConfirm(connection, await buildResolveTx(connection, keys, outcome), [oracle]);
}

test("a market lives: seed one YES/NO pool, bet bigger than the seed, sell back, close, resolve YES, redeem", async (t) => {
  const step = stepRunner(t);
  let keys: MarketKeys;
  let aliceStart = 0;

  await step("the oracle creates the market: question, vault, one YES/NO pool at 50/50", async () => {
    const before = await balance(oracle);
    const created = await createMarket("1");
    keys = created.keys;
    assert.ok(created.pool.state.tokenAMint.equals(keys.mints.yes) && created.pool.state.tokenBMint.equals(keys.mints.no));
    assert.ok(Math.abs(sumsToOne(created.pool) - 0.5) < 1e-9, "starts at 50/50");
    verifyMarketPool(keys, created.pool);
    // Any one field off and the pool isn't ours.
    const off = (patch: Record<string, unknown>) => ({ ...created.pool, state: { ...created.pool.state, ...patch } });
    for (const patch of [
      { tokenAMint: keys.mints.no },
      { tokenBMint: NATIVE_MINT },
      { sqrtMinPrice: created.pool.state.sqrtMinPrice.addn(1) },
      { sqrtMaxPrice: created.pool.state.sqrtMaxPrice.subn(1) },
      { collectFeeMode: 1 },
      { poolFees: { ...created.pool.state.poolFees, dynamicFee: { ...created.pool.state.poolFees.dynamicFee, initialized: 1 } } },
    ]) {
      assert.throws(() => verifyMarketPool(keys, off(patch)), /doesn't match/, JSON.stringify(Object.keys(patch)));
    }
    const spent = (before - (await balance(oracle))) / 1e9;
    t.diagnostic(`market cost the oracle ${spent} SOL with a ${Number(SEED) / 1e9} SOL seed (incl. names)`);
  });

  await step("quotes match the Gnosis FPMM formula on the pool's virtual reserves (full-range equivalent)", async () => {
    const p = await pool(keys);
    const { liquidity, sqrtPrice, collectFeeMode } = p.state;
    // Inside its range a concentrated pool trades like x*y=k on these virtual reserves.
    const vYes = BigInt(getAmountAFromLiquidityDelta(sqrtPrice, MAX_SQRT_PRICE, liquidity, Rounding.Down, collectFeeMode).toString());
    const vNo = BigInt(getAmountBFromLiquidityDelta(MIN_SQRT_PRICE, sqrtPrice, liquidity, Rounding.Down, collectFeeMode).toString());
    for (const sol of ["0.01", "0.1", "0.4"]) {
      const amount = solToLamports(sol);
      const ours = Number(quoteMarketTrade(p, { side: "yes", action: "buy", amount }, 100).outputAmount.toString());
      const fpmm = Number(fpmmBuyAmount(vYes, vNo, BigInt(amount.toString()), MARKET_FEE_BPS));
      // DAMM takes its fee from the swap's output, FPMM from the bet: within the fee of each other.
      assert.ok(Math.abs(ours - fpmm) / fpmm < 0.004, `${sol} SOL: pool ${ours} vs FPMM ${fpmm}`);
    }
  });

  await step("alice buys YES with 2 SOL, 4x the seed: it fills, and YES moves toward 1", async () => {
    aliceStart = await balance(alice);
    const quote = await trade(keys, alice, { side: "yes", action: "buy", amount: solToLamports("2") });
    const yes = await tokenBalance(keys, "yes", alice);
    assert.ok(yes >= BigInt(quote.minimumAmountOut.toString()), "alice got at least her minimum");
    assert.ok(yes > BigInt(solToLamports("2").toString()), "2 SOL buys more than 2 YES (each pays 1 SOL if YES)");
    assert.equal(await tokenBalance(keys, "no", alice), BigInt(0), "every NO from the split went into the swap");
    const after = sumsToOne(await pool(keys));
    assert.ok(after > 0.9, `YES is at ${after}`);
    assert.ok(Math.abs(after - quote.probabilityAfter) < 1e-6, "the quote said where the price would go");
    assert.equal(await connection.getAccountInfo(getAssociatedTokenAddressSync(NATIVE_MINT, alice.publicKey)), null, "no wrapped SOL left behind");
  });

  await step("bob buys NO and sells it all back: a round trip loses only fees and price impact", async () => {
    const before = await balance(bob);
    await trade(keys, bob, { side: "no", action: "buy", amount: solToLamports("0.05") });
    const no = await tokenBalance(keys, "no", bob);
    const sell = await trade(keys, bob, { side: "no", action: "sell", amount: new BN(no.toString()) });
    // Bob's new YES and NO token accounts hold rent he gets back by closing them: not a trading cost.
    const accounts = await connection.getMultipleAccountsInfo((["yes", "no"] as const).map((side) => getAssociatedTokenAddressSync(keys.mints[side], bob.publicKey)));
    const rent = accounts.reduce((sum, a) => sum + (a?.lamports ?? 0), 0);
    const cost = before - (await balance(bob)) - rent;
    assert.ok(cost > 0, "a round trip costs something");
    assert.ok(cost < 0.05 * 0.02 * 1e9, `it costs ${cost / 1e9} SOL of 0.05 besides rent (fees 0.3% twice, impact, network fees)`);
    assert.ok(sell.outputAmount.gt(new BN(0)));
    assert.ok((await tokenBalance(keys, "no", bob)) < BigInt(1000), "at most dust is left");
    sumsToOne(await pool(keys));
  });

  await step("closing trading takes the oracle's liquidity out", async () => {
    for (const tx of await buildCloseTradingTxs(connection, keys, await pool(keys))) await sendAndConfirm(connection, tx, [oracle]);
    assert.deepEqual(await buildCloseTradingTxs(connection, keys, await pool(keys)), [], "nothing left to close");
    await assert.rejects(Promise.resolve().then(async () => quoteMarketTrade(await pool(keys), { side: "yes", action: "buy", amount: solToLamports("0.01") }, 100)));
  });

  await step("the oracle resolves YES, once", async () => {
    await sendAndConfirm(connection, await buildResolveTx(connection, keys, "yes"), [oracle]);
    await assert.rejects(buildResolveTx(connection, keys, "no"), /already resolved/);
  });

  await step("alice redeems her YES for more SOL than she bet; the oracle redeems what its liquidity came back as", async () => {
    await sendAndConfirm(connection, await buildRedeemTx(connection, keys, alice.publicKey), [alice]);
    assert.ok((await balance(alice)) - aliceStart > 0, "alice is up");
    assert.equal(await tokenBalance(keys, "yes", alice), BigInt(0));
    await sendAndConfirm(connection, await buildRedeemTx(connection, keys, oracle.publicKey), [oracle]);
    const outstanding = BigInt((await connection.getTokenSupply(keys.mints.yes)).value.amount);
    assert.equal(await vaultLamports(keys), outstanding, "the vault holds exactly what the unredeemed YES can claim");
  });
});

test("a disputed or cancelled market refunds: every YES and NO pays half", async () => {
  const { keys } = await createMarket("2");
  await trade(keys, alice, { side: "yes", action: "buy", amount: solToLamports("0.05") });
  await trade(keys, bob, { side: "no", action: "buy", amount: solToLamports("0.05") });
  await assert.rejects(buildRedeemTx(connection, keys, alice.publicKey), /isn't resolved yet/);
  await closeAndResolve(keys, "refund");

  for (const wallet of [alice, bob, oracle]) {
    const tokens = { yes: await tokenBalance(keys, "yes", wallet), no: await tokenBalance(keys, "no", wallet) };
    const expected = redeemLamports(tokens.yes, "yes", payoutNumerators("refund")) + redeemLamports(tokens.no, "no", payoutNumerators("refund"));
    const before = await vaultLamports(keys);
    await sendAndConfirm(connection, await buildRedeemTx(connection, keys, wallet.publicKey), [wallet]);
    assert.equal(before - (await vaultLamports(keys)), expected, "half a SOL per share");
  }
  // The emptied pool may keep a few units of YES/NO as rounding dust; the vault backs exactly those.
  const supply = async (side: "yes" | "no") => BigInt((await connection.getTokenSupply(keys.mints[side])).value.amount);
  const left = await vaultLamports(keys);
  const owed = ((await supply("yes")) + (await supply("no"))) / BigInt(2);
  assert.ok(left >= owed && left - owed <= BigInt(4), `the vault keeps ${left} for ${owed} owed: only rounding dust beyond it`);
});

test("the server runs a market: the oracle creates, closes and resolves; wallets bet and redeem in registered markets only", async () => {
  process.env.MEMESTREAM_RPC_URL = surfnet.rpcUrl;
  process.env.MEMESTREAM_CONFIG = Keypair.generate().publicKey.toBase58(); // unused by markets
  process.env.MEMESTREAM_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.MEMESTREAM_MARKET_ORACLE = oracle.publicKey.toBase58();
  process.env.MEMESTREAM_MARKET_ORACLE_KEY = JSON.stringify(Array.from(oracle.secretKey));
  process.env.MEMESTREAM_MARKET_SECRET = SECRET;
  const server = await import("../../src/server/markets");
  const ref = { mint: coinMint.toBase58(), predictionId: "3" };
  const now = Date.now();

  const before = await balance(oracle);
  const created = await server.createMarket({ ...ref, ticker: "test", seedSol: "0.05" });
  assert.equal(created.signatures.length, 3, "init, split, the pool (no names by default)");
  console.log(`# a 0.05 SOL market costs the oracle ${(before - (await balance(oracle))) / 1e9} SOL up front (seed + rent + fees)`);
  const record = { ...created.record, lockAt: now + 60_000, source: "" };
  assert.deepEqual((await server.createMarket({ ...ref, ticker: "test", seedSol: "0.05" })).signatures, [], "a second create finds every step done");
  const opened = await server.getMarket(record, alice.publicKey.toBase58(), now);
  assert.equal(opened.trading, true);
  assert.ok(Math.abs(opened.probability.yes - 0.5) < 1e-6 && Math.abs(opened.probability.yes + opened.probability.no - 1) < 1e-12);
  assert.equal(opened.volumeSol, "0");
  assert.deepEqual([opened.position?.yes, opened.position?.no], ["0", "0"]);

  // 1 SOL on a 0.05 SOL seed: any size fills, only the price moves.
  const bet = { ...ref, side: "yes" as const, action: "buy" as const, amount: "1", slippageBps: 100 };
  const preview = await server.previewMarketTrade(record, bet, now);
  assert.equal(preview.spent, "1");
  assert.ok(Number(preview.received) > 1 && preview.probabilityAfter > 0.95 && preview.priceImpact > 0.05, JSON.stringify(preview));
  const prepared = await server.buildMarketTradeForWallet(record, { ...bet, wallet: alice.publicKey.toBase58(), minReceived: preview.minimumReceived }, now);
  assert.equal(await signAndSend(prepared, alice), "confirmed");
  const after = await server.getMarket(record, alice.publicKey.toBase58(), now);
  assert.ok(after.probability.yes > 0.95, "the YES bet moved the odds");
  // Volume counts shares the pool swapped out; on a 0.05 SOL seed the 1 SOL bet swapped out ~0.049 YES.
  assert.ok(Number(after.volumeSol) > 0.04 && Number(after.volumeSol) < 0.06, `volume ${after.volumeSol}`);
  assert.ok(Number(after.position?.yes) >= Number(preview.minimumReceived), `alice holds ${after.position?.yes} YES`);

  // Betting closes at lockAt, whatever the pool holds.
  await assert.rejects(server.previewMarketTrade(record, bet, record.lockAt), /closed/);
  await assert.rejects(server.buildMarketTradeForWallet(record, { ...bet, wallet: alice.publicKey.toBase58() }, record.lockAt), /closed/);
  assert.equal((await server.getMarket(record, null, record.lockAt)).trading, false);

  await assert.rejects(server.buildMarketRedeemForWallet(record, alice.publicKey.toBase58()), /isn't resolved yet/);
  assert.equal((await server.closeMarketTrading(record)).length, 1);
  assert.deepEqual(await server.closeMarketTrading(record), [], "closing again sends nothing");
  assert.ok(await server.resolveMarket(record, "yes"));
  assert.equal(await server.resolveMarket(record, "no"), null, "resolving again sends nothing");
  const resolved = await server.getMarket(record, null, now);
  assert.deepEqual([resolved.trading, resolved.resolved, resolved.payoutNumerators], [false, true, [1, 0]], "a resolved market is closed even before lockAt");

  const aliceBefore = await balance(alice);
  assert.equal(await signAndSend(await server.buildMarketRedeemForWallet(record, alice.publicKey.toBase58()), alice), "confirmed");
  assert.ok((await balance(alice)) - aliceBefore > Number(solToLamports("1")), "alice's YES paid more than her 1 SOL bet");
  await server.redeemOracleTokens(record);

  // A record that doesn't match what our oracle would make is refused.
  await assert.rejects(server.getMarket({ ...record, oracle: Keypair.generate().publicKey.toBase58() }, null, now), /No market/);
  await assert.rejects(server.getMarket({ ...record, pool: record.mints.yes }, null, now), /No market/);
});

test("a bad oracle key never shows in the error", async () => {
  const server = await import("../../src/server/markets");
  const saved = process.env.MEMESTREAM_MARKET_ORACLE_KEY;
  process.env.MEMESTREAM_MARKET_ORACLE_KEY = "[12,34,56,secret-looking";
  try {
    await assert.rejects(server.createMarket({ mint: coinMint.toBase58(), predictionId: "4", ticker: "test", seedSol: "0.05" }), (error: Error) => {
      assert.equal(error.message, "Oracle key is not set up correctly");
      return true;
    });
  } finally {
    process.env.MEMESTREAM_MARKET_ORACLE_KEY = saved;
  }
});
