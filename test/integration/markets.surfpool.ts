// Integration test: a prediction market's full life on an offline local chain with the real
// programs (MetaDAO conditional vault + Meteora DAMM v2): create and seed, bet both sides, sell,
// close trading, resolve, redeem. Plus the refund path, where every token pays half.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { solToLamports } from "../../src/lib/dbc/units";
import { buildCreateMarketTxs } from "../../src/lib/markets/create";
import { payoutNumerators, redeemLamports } from "../../src/lib/markets/math";
import { loadMarketPools, type MarketKeys, marketKeys, marketOdds, type MarketPools } from "../../src/lib/markets/pool";
import { buildCloseTradingTxs, buildRedeemTx, buildResolveTx } from "../../src/lib/markets/settle";
import { isTradingOpen, type MarketOrder, prepareMarketTrade, quoteMarketTrade } from "../../src/lib/markets/trade";
import { stepRunner } from "../support/steps";

const [oracle, alice, bob] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const coinMint = Keypair.generate().publicKey;
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

async function createMarket(predictionId: string): Promise<{ keys: MarketKeys; pools: MarketPools }> {
  const keys = marketKeys(connection, coinMint, predictionId, oracle.publicKey);
  for (const tx of await buildCreateMarketTxs(connection, keys, NAMES, SEED_PER_POOL)) await sendAndConfirm(connection, tx, [oracle]);
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
    assert.throws(() => quoteMarketTrade(closed, { side: "no", action: "sell", amount: new BN(1000) }, 100), /closed/);
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
