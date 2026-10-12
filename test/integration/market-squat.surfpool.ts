// Regression test (security audit, 2026-10-12): anyone can create a MetaDAO question naming our
// oracle, and a DAMM v2 pool at a market's derived address with the tokens reversed. The app then
// traded in the squatter's pools ("sell YES" spent the user's SOL). Now:
// - question ids are keyed by a server secret, so the addresses can't be worked out in advance;
// - a squat placed after our first transaction shows its addresses is caught: the pools must be
//   exactly ours, so the create fails and the market is never registered, and nothing trades in it.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { CollectFeeMode, CpAmm, MAX_SQRT_PRICE, MIN_SQRT_PRICE } from "@meteora-ag/cp-amm-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { built } from "../../src/lib/dbc/tx";
import { unwrapSolIx, wrapSolIxs } from "../../src/lib/markets/create";
import { loadMarketPools, marketKeys, marketKeysFromId, marketPoolFees, verifyMarketPools } from "../../src/lib/markets/pool";
import { initializeMarketIxs, splitIxs } from "../../src/lib/markets/vault";

const [oracle, attacker] = [Keypair.generate(), Keypair.generate()];
const coinMint = Keypair.generate().publicKey;
const SECRET = randomBytes(32).toString("hex");
let surfnet: Surfnet;
let connection: Connection;

before(async () => {
  surfnet = await startOfflineSurfnet([oracle, attacker]);
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
  await assert.rejects(server.createMarket({ mint: coinMint.toBase58(), predictionId: "42", ticker: "test", seedSolPerPool: "0.05" }), /don't match memestream's/, "the oracle's create fails, so it is never registered");

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
