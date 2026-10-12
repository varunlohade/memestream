// Integration test: a prediction market's full life on an offline local chain with the real
// programs (MetaDAO conditional vault + Meteora DAMM v2): create and seed, bet both sides, sell,
// close trading, resolve, redeem. Plus the refund path, where every token pays half.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { solToLamports } from "../../src/lib/dbc/units";
import { buildCreateMarketTxs, buildMarketMetadataTx } from "../../src/lib/markets/create";
import { positionNfts } from "../../src/lib/markets/provenance";
import { payoutNumerators, redeemLamports } from "../../src/lib/markets/math";
import { loadMarketPools, type MarketKeys, marketKeys, marketOdds, type MarketPools, verifyMarketPools } from "../../src/lib/markets/pool";
import { buildCloseTradingTxs, buildRedeemTx, buildResolveTx } from "../../src/lib/markets/settle";
import { isTradingOpen, type MarketOrder, prepareMarketTrade, quoteMarketTrade } from "../../src/lib/markets/trade";
import { pollUntil } from "../../src/lib/poll";
import { signatureStatus } from "../../src/lib/tx-status";
import { stepRunner } from "../support/steps";

const [oracle, alice, bob] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const coinMint = Keypair.generate().publicKey;
const SECRET = randomBytes(32).toString("hex");
const SEED_PER_POOL = solToLamports("0.5");
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

async function createMarket(predictionId: string): Promise<{ keys: MarketKeys; pools: MarketPools }> {
  const keys = marketKeys(connection, SECRET, coinMint, predictionId, oracle.publicKey);
  for (const tx of await buildCreateMarketTxs(connection, keys, SEED_PER_POOL, positionNfts(SECRET, keys.questionId))) await sendAndConfirm(connection, tx, [oracle]);
  await sendAndConfirm(connection, await buildMarketMetadataTx(connection, keys, NAMES), [oracle]);
  const pools = await loadMarketPools(connection, keys);
  assert.ok(pools, "both pools exist");
  return { keys, pools };
}

async function trade(keys: MarketKeys, wallet: Keypair, order: MarketOrder) {
  const pools = await loadMarketPools(connection, keys);
  assert.ok(pools);
  const built = await prepareMarketTrade(connection, pools, wallet.publicKey, order, 100);
  await sendAndConfirm(connection, built, [wallet]);
  return built.quote;
}

async function closeAndResolve(keys: MarketKeys, outcome: "yes" | "no" | "refund") {
  const pools = await loadMarketPools(connection, keys);
  assert.ok(pools);
  const closes = await buildCloseTradingTxs(connection, keys, pools);
  assert.equal(closes.length, 2, "one close per pool");
  for (const tx of closes) await sendAndConfirm(connection, tx, [oracle]);
  await sendAndConfirm(connection, await buildResolveTx(connection, keys, outcome), [oracle]);
}

test("a market lives: seed, bet YES and NO, sell, close, resolve YES, redeem", async (t) => {
  const step = stepRunner(t);
  let keys: MarketKeys;
  let aliceStart = 0;
  let aliceYes = BigInt(0);

  await step("the oracle creates the market: question, vault, YES/NO names, two pools at 0.5", async () => {
    const before = await balance(oracle);
    const created = await createMarket("1");
    keys = created.keys;
    const odds = marketOdds(created.pools);
    assert.ok(Math.abs(odds.priceSol.yes - 0.5) < 1e-6 && Math.abs(odds.priceSol.no - 0.5) < 1e-6, JSON.stringify(odds));
    for (const side of ["yes", "no"] as const) {
      assert.ok(created.pools[side].state.tokenAMint.equals(keys.mints[side]));
      assert.ok(created.pools[side].state.tokenBMint.equals(NATIVE_MINT));
      const meta = await connection.getParsedAccountInfo(keys.mints[side]);
      assert.ok(meta.value, "the conditional mint exists");
    }
    verifyMarketPools(keys, created.pools);
    // Any one field off and the pools aren't ours.
    const off = (side: "yes" | "no", patch: Record<string, unknown>) => ({ ...created.pools, [side]: { ...created.pools[side], state: { ...created.pools[side].state, ...patch } } });
    for (const patch of [
      { tokenAMint: NATIVE_MINT },
      { tokenBMint: keys.mints.yes },
      { sqrtMinPrice: created.pools.yes.state.sqrtMinPrice.addn(1) },
      { sqrtMaxPrice: created.pools.yes.state.sqrtMaxPrice.subn(1) },
      { collectFeeMode: 0 },
      { poolFees: { ...created.pools.yes.state.poolFees, dynamicFee: { ...created.pools.yes.state.poolFees.dynamicFee, initialized: 1 } } },
    ]) {
      assert.throws(() => verifyMarketPools(keys, off("yes", patch)), /don't match/, JSON.stringify(Object.keys(patch)));
    }
    const spent = (before - (await balance(oracle))) / 1e9;
    t.diagnostic(`market cost the oracle ${spent} SOL with ${Number(SEED_PER_POOL) / 1e9} SOL per pool`);
  });

  await step("alice buys YES and bob buys NO with SOL; prices move apart", async () => {
    aliceStart = await balance(alice);
    const quote = await trade(keys, alice, { side: "yes", action: "buy", amount: solToLamports("0.1") });
    aliceYes = await tokenBalance(keys, "yes", alice);
    assert.ok(aliceYes >= BigInt(quote.minimumAmountOut.toString()), "alice got at least her minimum");
    assert.ok(aliceYes > BigInt(solToLamports("0.1").toString()), "at ~0.5 SOL each, 0.1 SOL buys more than 0.1 YES");
    await trade(keys, bob, { side: "no", action: "buy", amount: solToLamports("0.2") });
    const odds = marketOdds((await loadMarketPools(connection, keys))!);
    assert.ok(odds.priceSol.yes > 0.5 && odds.priceSol.no > 0.5, "buying a side raises its price");
    assert.ok(odds.probability.no > odds.probability.yes, "more SOL on NO makes NO likelier");
    assert.equal(await connection.getAccountInfo(getAssociatedTokenAddressSync(NATIVE_MINT, alice.publicKey)), null, "no wrapped SOL left behind");
  });

  await step("a bet bigger than the pool's stock is refused before it reaches the chain", async () => {
    const pools = (await loadMarketPools(connection, keys))!;
    // 0.5 SOL per pool: ~0.21 SOL more of buys takes YES from ~0.57 to 1.
    await assert.rejects(quoteMarketTrade(pools, { side: "yes", action: "buy", amount: solToLamports("0.3") }, 100), /Too big for this market/);
    await assert.rejects(prepareMarketTrade(connection, pools, alice.publicKey, { side: "yes", action: "buy", amount: solToLamports("0.3") }, 100), /Too big/);
  });

  await step("bob sells half his NO back for SOL", async () => {
    const no = await tokenBalance(keys, "no", bob);
    const before = await balance(bob);
    await trade(keys, bob, { side: "no", action: "sell", amount: new BN((no / BigInt(2)).toString()) });
    assert.equal(await tokenBalance(keys, "no", bob), no - no / BigInt(2));
    assert.ok((await balance(bob)) > before, "bob got SOL back");
  });

  await step("closing trading empties both pools; no more bets or sells", async () => {
    const pools = (await loadMarketPools(connection, keys))!;
    const closes = await buildCloseTradingTxs(connection, keys, pools);
    for (const tx of closes) await sendAndConfirm(connection, tx, [oracle]);
    const closed = (await loadMarketPools(connection, keys))!;
    assert.equal(isTradingOpen(closed), false);
    await assert.rejects(quoteMarketTrade(closed, { side: "no", action: "sell", amount: new BN(1000) }, 100), /closed/);
    assert.deepEqual(await buildCloseTradingTxs(connection, keys, closed), [], "nothing left to close");
  });

  await step("the oracle resolves YES, once", async () => {
    await sendAndConfirm(connection, await buildResolveTx(connection, keys, "yes"), [oracle]);
    await assert.rejects(buildResolveTx(connection, keys, "no"), /already resolved/);
  });

  await step("alice redeems her YES for more SOL than she bet; bob's NO pays 0", async () => {
    await sendAndConfirm(connection, await buildRedeemTx(connection, keys, alice.publicKey), [alice]);
    const gained = (await balance(alice)) - aliceStart;
    assert.ok(gained > 0, `alice is up ${gained} lamports net of fees`);
    assert.equal(await tokenBalance(keys, "yes", alice), BigInt(0));

    const vaultBefore = await vaultLamports(keys);
    await sendAndConfirm(connection, await buildRedeemTx(connection, keys, bob.publicKey), [bob]);
    assert.equal(await vaultLamports(keys), vaultBefore, "the vault paid bob nothing");
    assert.equal(await tokenBalance(keys, "no", bob), BigInt(0), "bob's NO is burned");
    await assert.rejects(buildRedeemTx(connection, keys, bob.publicKey), /holds no YES or NO/);
  });

  await step("the oracle redeems the tokens its liquidity came back as; the vault ends empty", async () => {
    const yes = await tokenBalance(keys, "yes", oracle);
    assert.ok(yes > BigInt(0), "the oracle got YES back from the pool");
    const before = await vaultLamports(keys);
    await sendAndConfirm(connection, await buildRedeemTx(connection, keys, oracle.publicKey), [oracle]);
    assert.equal(before - (await vaultLamports(keys)), yes, "1 SOL per winning YES");
    // The emptied pool may keep a unit or two of YES as rounding dust; the vault backs exactly those.
    const outstanding = BigInt((await connection.getTokenSupply(keys.mints.yes)).value.amount);
    assert.ok(outstanding <= BigInt(2), `only dust YES is left: ${outstanding}`);
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
    assert.equal(before - (await vaultLamports(keys)), expected, "half a SOL per token");
  }
  assert.ok((await vaultLamports(keys)) <= BigInt(2), "at most rounding dust stays in the vault");
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

  const created = await server.createMarket({ ...ref, ticker: "test", seedSolPerPool: "0.05" });
  assert.equal(created.signatures.length, 4, "init, split, two pools");
  const record = { ...created.record, lockAt: now + 60_000 };
  assert.deepEqual((await server.createMarket({ ...ref, ticker: "test", seedSolPerPool: "0.05" })).signatures, [], "a second create finds every step done");
  const opened = await server.getMarket(record, alice.publicKey.toBase58(), now);
  assert.equal(opened.trading, true);
  assert.equal(opened.resolved, false);
  assert.ok(Math.abs(opened.probability.yes - 0.5) < 1e-6);
  assert.equal(opened.volumeSol, "0");
  assert.deepEqual([opened.position?.yes, opened.position?.no], ["0", "0"]);
  assert.ok(Number(opened.maxBuySol.yes) > 0.015 && Number(opened.maxBuySol.yes) < 0.0215, `max buy ${opened.maxBuySol.yes} SOL on a 0.05 seed`);

  const bet = { ...ref, side: "yes" as const, action: "buy" as const, amount: "0.01", slippageBps: 100 };
  const preview = await server.previewMarketTrade(record, bet, now);
  assert.equal(preview.spent, "0.01");
  const prepared = await server.buildMarketTradeForWallet(record, { ...bet, wallet: alice.publicKey.toBase58(), minReceived: preview.minimumReceived }, now);
  assert.equal(await signAndSend(prepared, alice), "confirmed");
  const after = await server.getMarket(record, alice.publicKey.toBase58(), now);
  assert.ok(after.probability.yes > 0.5, "the YES bet moved the odds");
  assert.equal(after.volumeSol, "0.01", "volume from the SOL fees");
  assert.ok(Number(after.position?.yes) > 0.01, `alice holds ${after.position?.yes} YES`);
  await assert.rejects(server.previewMarketTrade(record, { ...bet, amount: opened.maxBuySol.yes }, now), /Too big/, "the pool's stock moved: the old max no longer fits");

  // Betting closes at lockAt, whatever the pools hold.
  await assert.rejects(server.previewMarketTrade(record, bet, record.lockAt), /closed/);
  await assert.rejects(server.buildMarketTradeForWallet(record, { ...bet, wallet: alice.publicKey.toBase58() }, record.lockAt), /closed/);
  assert.equal((await server.getMarket(record, null, record.lockAt)).trading, false);

  await assert.rejects(server.buildMarketRedeemForWallet(record, alice.publicKey.toBase58()), /isn't resolved yet/);
  assert.equal((await server.closeMarketTrading(record)).length, 2);
  assert.deepEqual(await server.closeMarketTrading(record), [], "closing again sends nothing");
  assert.ok(await server.resolveMarket(record, "yes"));
  assert.equal(await server.resolveMarket(record, "no"), null, "resolving again sends nothing");
  const resolved = await server.getMarket(record, null, now);
  assert.deepEqual([resolved.trading, resolved.resolved, resolved.payoutNumerators], [false, true, [1, 0]], "a resolved market is closed even before lockAt");

  const before = await balance(alice);
  assert.equal(await signAndSend(await server.buildMarketRedeemForWallet(record, alice.publicKey.toBase58()), alice), "confirmed");
  assert.ok((await balance(alice)) - before > Number(solToLamports("0.01")), "alice's YES paid more than her 0.01 SOL bet");
  await server.redeemOracleTokens(record);

  // A record that doesn't match what our oracle would make is refused.
  const otherOracle = Keypair.generate().publicKey.toBase58();
  await assert.rejects(server.getMarket({ ...record, oracle: otherOracle }, null, now), /No market/);
  await assert.rejects(server.getMarket({ ...record, pools: { ...record.pools, yes: record.pools.no } }, null, now), /No market/);
});

test("a bad oracle key never shows in the error", async () => {
  const server = await import("../../src/server/markets");
  const saved = process.env.MEMESTREAM_MARKET_ORACLE_KEY;
  process.env.MEMESTREAM_MARKET_ORACLE_KEY = "[12,34,56,secret-looking";
  try {
    await assert.rejects(server.createMarket({ mint: coinMint.toBase58(), predictionId: "4", ticker: "test", seedSolPerPool: "0.05" }), (error: Error) => {
      assert.equal(error.message, "Oracle key is not set up correctly");
      return true;
    });
  } finally {
    process.env.MEMESTREAM_MARKET_ORACLE_KEY = saved;
  }
});
