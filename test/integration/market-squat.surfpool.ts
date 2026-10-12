// Regression test (security audit, 2026-10-12): anyone can create a MetaDAO question naming our
// oracle, and a DAMM v2 pool at a market's derived address with the tokens reversed. The app then
// traded in the squatter's pools ("sell YES" spent the user's SOL). Now:
// - question ids are keyed by a server secret, so the addresses can't be worked out in advance;
// - a squat placed after our first transaction shows its addresses is caught: the pools must be
//   exactly ours, so the create fails and the market is never registered, and nothing trades in it.
// Re-audit: a "gift squat" copies our range and fee, starts at another price and names our oracle as
// the pool's (unsigned) creator, so the oracle "holds liquidity". Pools now count as ours only if
// they hold the position whose NFT keypair our secret derives; nobody else can make that one.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { CollectFeeMode, CpAmm, getAmountAFromLiquidityDelta, getLiquidityDeltaFromAmountB, getSqrtPriceFromPrice, MAX_SQRT_PRICE, MIN_SQRT_PRICE, Rounding } from "@meteora-ag/cp-amm-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { built } from "../../src/lib/dbc/tx";
import { unwrapSolIx, wrapSolIxs } from "../../src/lib/markets/create";
import { ACTIVATION_TYPE, COLLECT_FEE_MODE, loadMarketPools, marketKeys, marketKeysFromId, marketPoolFees, PRICE_RANGE, verifyMarketPools } from "../../src/lib/markets/pool";
import { initializeMarketIxs, splitIxs } from "../../src/lib/markets/vault";

const [oracle, attacker, victim] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const coinMint = Keypair.generate().publicKey;
const SECRET = randomBytes(32).toString("hex");
let surfnet: Surfnet;
let connection: Connection;

before(async () => {
  surfnet = await startOfflineSurfnet([oracle, attacker, victim]);
  connection = new Connection(surfnet.rpcUrl, "confirmed");
});
after(() => surfnet?.stop());

test("a market's addresses can't be worked out from the coin and the prediction id", () => {
  const ours = marketKeys(connection, SECRET, coinMint, "42", oracle.publicKey);
  const guess = marketKeysFromId(connection, new Uint8Array(createHash("sha256").update(`memestream:market:v1:${coinMint.toBase58()}:42`).digest()), oracle.publicKey);
  assert.ok(!guess.question.equals(ours.question) && !guess.pools.yes.equals(ours.pools.yes));
});

test("a squat at our market's addresses (seen after our first transaction) is refused: no create, no trades", async () => {
  const keys = marketKeys(connection, SECRET, coinMint, "42", oracle.publicKey);
  // The squatter makes the question naming our oracle, its vault, YES/NO, and reversed pools (token A = wSOL).
  await sendAndConfirm(connection, built(new Transaction().add(...(await initializeMarketIxs(connection, keys.questionId, oracle.publicKey, attacker.publicKey))), attacker.publicKey), [attacker]);
  const two = new BN(2_000_000_000);
  const split = new Transaction().add(...wrapSolIxs(attacker.publicKey, two), ...(await splitIxs(connection, keys, attacker.publicKey, two)), unwrapSolIx(attacker.publicKey));
  await sendAndConfirm(connection, built(split, attacker.publicKey), [attacker]);
  const cp = new CpAmm(connection);
  for (const side of ["yes", "no"] as const) {
    const one = new BN(1_000_000_000);
    const prepared = cp.preparePoolCreationParams({ tokenAAmount: one, tokenBAmount: one, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: CollectFeeMode.BothToken } as never);
    const nft = Keypair.generate();
    const { tx, pool } = await cp.createCustomPool({
      payer: attacker.publicKey,
      creator: attacker.publicKey,
      positionNft: nft.publicKey,
      tokenAMint: NATIVE_MINT,
      tokenBMint: keys.mints[side],
      tokenAAmount: one,
      tokenBAmount: one,
      sqrtMinPrice: MIN_SQRT_PRICE,
      sqrtMaxPrice: MAX_SQRT_PRICE,
      initSqrtPrice: prepared.initSqrtPrice,
      liquidityDelta: prepared.liquidityDelta,
      poolFees: marketPoolFees(),
      hasAlphaVault: false,
      activationType: 1,
      collectFeeMode: CollectFeeMode.BothToken,
      activationPoint: null,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      isLockLiquidity: false,
    });
    assert.ok(pool.equals(keys.pools[side]), "the squatter's pool sits at the address the app derives");
    tx.add(unwrapSolIx(attacker.publicKey));
    await sendAndConfirm(connection, built(tx, attacker.publicKey, [nft]), [attacker]);
  }

  const pools = await loadMarketPools(connection, keys);
  assert.ok(pools, "both squatted pools exist");
  assert.throws(() => verifyMarketPools(keys, pools), /don't match memestream's/, "the pool check refuses reversed tokens");

  process.env.MEMESTREAM_RPC_URL = surfnet.rpcUrl;
  process.env.MEMESTREAM_CONFIG = Keypair.generate().publicKey.toBase58();
  process.env.MEMESTREAM_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.MEMESTREAM_MARKET_ORACLE = oracle.publicKey.toBase58();
  process.env.MEMESTREAM_MARKET_ORACLE_KEY = JSON.stringify(Array.from(oracle.secretKey));
  process.env.MEMESTREAM_MARKET_SECRET = SECRET;
  const server = await import("../../src/server/markets");
  await assert.rejects(server.createMarket({ mint: coinMint.toBase58(), predictionId: "42", ticker: "test", seedSolPerPool: "0.05" }), /Someone else made a pool/, "the oracle's create gives up before sending anything, so it is never registered");

  // Even a record naming these addresses (as if registered) can't quote, trade or show odds.
  const record = {
    mint: coinMint.toBase58(),
    predictionId: "42",
    oracle: oracle.publicKey.toBase58(),
    questionId: Buffer.from(keys.questionId).toString("hex"),
    question: keys.question.toBase58(),
    vault: keys.vault.toBase58(),
    mints: { yes: keys.mints.yes.toBase58(), no: keys.mints.no.toBase58() },
    pools: { yes: keys.pools.yes.toBase58(), no: keys.pools.no.toBase58() },
    signature: "",
    lockAt: Date.now() + 60_000,
  };
  const sell = { mint: record.mint, predictionId: "42", side: "yes" as const, action: "sell" as const, amount: "1", slippageBps: 100 };
  await assert.rejects(server.getMarket(record, null, Date.now()), /don't match memestream's/);
  await assert.rejects(server.previewMarketTrade(record, sell, Date.now()), /don't match memestream's/);
  await assert.rejects(server.buildMarketTradeForWallet(record, { ...sell, wallet: attacker.publicKey.toBase58() }, Date.now()), /don't match memestream's/);
});

test("a gift squat (our range and fee, another start price, our oracle as creator) is never registered or traded", async () => {
  const keys = marketKeys(connection, SECRET, coinMint, "43", oracle.publicKey);
  // The oracle's own first transaction lands; from here the mints are public.
  await sendAndConfirm(connection, built(new Transaction().add(...(await initializeMarketIxs(connection, keys.questionId, oracle.publicKey, oracle.publicKey))), oracle.publicKey), [oracle]);
  const two = new BN(2_000_000_000);
  const split = new Transaction().add(...wrapSolIxs(attacker.publicKey, two), ...(await splitIxs(connection, keys, attacker.publicKey, two)), unwrapSolIx(attacker.publicKey));
  await sendAndConfirm(connection, built(split, attacker.publicKey), [attacker]);
  const start = getSqrtPriceFromPrice("0.9", 9, 9);
  const lamports = new BN(200_000_000);
  const liquidity = getLiquidityDeltaFromAmountB(lamports, PRICE_RANGE.min, start, COLLECT_FEE_MODE);
  const tokens = getAmountAFromLiquidityDelta(start, PRICE_RANGE.max, liquidity, Rounding.Up, COLLECT_FEE_MODE);
  const cp = new CpAmm(connection);
  for (const side of ["yes", "no"] as const) {
    const nft = Keypair.generate();
    const { tx, pool } = await cp.createCustomPool({
      payer: attacker.publicKey,
      creator: oracle.publicKey, // unsigned: the position NFT lands in the oracle's wallet
      positionNft: nft.publicKey,
      tokenAMint: keys.mints[side],
      tokenBMint: NATIVE_MINT,
      tokenAAmount: tokens,
      tokenBAmount: lamports,
      sqrtMinPrice: PRICE_RANGE.min,
      sqrtMaxPrice: PRICE_RANGE.max,
      initSqrtPrice: start,
      liquidityDelta: liquidity,
      poolFees: marketPoolFees(),
      hasAlphaVault: false,
      activationType: ACTIVATION_TYPE,
      collectFeeMode: COLLECT_FEE_MODE,
      activationPoint: null,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      isLockLiquidity: false,
    });
    assert.ok(pool.equals(keys.pools[side]));
    tx.add(unwrapSolIx(attacker.publicKey));
    await sendAndConfirm(connection, built(tx, attacker.publicKey, [nft]), [attacker]);
  }
  const pools = await loadMarketPools(connection, keys);
  assert.ok(pools);
  assert.doesNotThrow(() => verifyMarketPools(keys, pools), "the gift squat copies every pool parameter we check");

  const server = await import("../../src/server/markets");
  const oracleBefore = await connection.getBalance(oracle.publicKey);
  await assert.rejects(
    server.createMarket({ mint: coinMint.toBase58(), predictionId: "43", ticker: "test", seedSolPerPool: "0.05" }),
    (error: Error) => error instanceof server.MarketUnavailableError,
    "the create gives up for good: the pools aren't ours",
  );
  assert.equal(await connection.getBalance(oracle.publicKey), oracleBefore, "and the oracle sent nothing more");

  const record = {
    mint: coinMint.toBase58(),
    predictionId: "43",
    oracle: oracle.publicKey.toBase58(),
    questionId: Buffer.from(keys.questionId).toString("hex"),
    question: keys.question.toBase58(),
    vault: keys.vault.toBase58(),
    mints: { yes: keys.mints.yes.toBase58(), no: keys.mints.no.toBase58() },
    pools: { yes: keys.pools.yes.toBase58(), no: keys.pools.no.toBase58() },
    signature: "",
    lockAt: Date.now() + 600_000,
  };
  const buy = { mint: record.mint, predictionId: "43", side: "yes" as const, action: "buy" as const, amount: "0.005", slippageBps: 100 };
  await assert.rejects(server.getMarket(record, null, Date.now()), /weren't made by memestream/);
  await assert.rejects(server.previewMarketTrade(record, buy, Date.now()), /weren't made by memestream/);
  await assert.rejects(server.buildMarketTradeForWallet(record, { ...buy, wallet: victim.publicKey.toBase58() }, Date.now()), /weren't made by memestream/);
});
