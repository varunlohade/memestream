// Regression tests (security audits, 2026-10-12): anyone can create a MetaDAO question naming our
// oracle, and a DAMM v2 pool at a market's derived address, with the tokens reversed (the app then
// traded in the squatter's pool: "sell YES" spent the user's SOL), or with our exact range and fee,
// another start price and our oracle named as its unsigned creator ("gift squat"). Now:
// - question ids are keyed by a server secret, so the addresses can't be worked out in advance;
// - after our first transaction shows them, a squat is still caught: the pool counts as ours only if
//   it holds the position whose NFT keypair our secret derives, which nobody else can make. So the
//   create gives up, the market is never registered, and nothing quotes or trades in it.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { CollectFeeMode, CpAmm, getLiquidityDeltaFromAmountA, getLiquidityDeltaFromAmountB, getSqrtPriceFromPrice, MAX_SQRT_PRICE, MIN_SQRT_PRICE } from "@meteora-ag/cp-amm-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Surfnet } from "@solana/surfpool";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { startOfflineSurfnet } from "../../scripts/local-chain/offline-surfnet";
import { sendAndConfirm } from "../../scripts/local-chain/send-and-confirm";
import { built } from "../../src/lib/dbc/tx";
import { unwrapSolIx, wrapSolIxs } from "../../src/lib/markets/create";
import { ACTIVATION_TYPE, COLLECT_FEE_MODE, loadMarketPool, type MarketKeys, marketKeys, marketKeysFromId, marketPoolFees, PRICE_RANGE, verifyMarketPool } from "../../src/lib/markets/pool";
import { initializeMarketIxs, splitIxs } from "../../src/lib/markets/vault";

const [oracle, attacker, victim] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const coinMint = Keypair.generate().publicKey;
const SECRET = randomBytes(32).toString("hex");
let surfnet: Surfnet;
let connection: Connection;

before(async () => {
  surfnet = await startOfflineSurfnet([oracle, attacker, victim]);
  connection = new Connection(surfnet.rpcUrl, "confirmed");
  process.env.MEMESTREAM_RPC_URL = surfnet.rpcUrl;
  process.env.MEMESTREAM_CONFIG = Keypair.generate().publicKey.toBase58();
  process.env.MEMESTREAM_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.MEMESTREAM_MARKET_ORACLE = oracle.publicKey.toBase58();
  process.env.MEMESTREAM_MARKET_ORACLE_KEY = JSON.stringify(Array.from(oracle.secretKey));
  process.env.MEMESTREAM_MARKET_SECRET = SECRET;
});
after(() => surfnet?.stop());

/** Our first transaction lands (question + vault), then the squatter splits SOL for YES + NO. */
async function squatStart(predictionId: string): Promise<MarketKeys> {
  const keys = marketKeys(connection, SECRET, coinMint, predictionId, oracle.publicKey);
  await sendAndConfirm(connection, built(new Transaction().add(...(await initializeMarketIxs(connection, keys.questionId, oracle.publicKey, oracle.publicKey))), oracle.publicKey), [oracle]);
  const two = new BN(2_000_000_000);
  const split = new Transaction().add(...wrapSolIxs(attacker.publicKey, two), ...(await splitIxs(connection, keys, attacker.publicKey, two)), unwrapSolIx(attacker.publicKey));
  await sendAndConfirm(connection, built(split, attacker.publicKey), [attacker]);
  return keys;
}

type PoolShape = { reversed: boolean; creator: Keypair; sqrtMin: BN; sqrtMax: BN; start: BN | null; mode: CollectFeeMode };

async function squatPool(keys: MarketKeys, shape: PoolShape) {
  const cp = new CpAmm(connection);
  const one = new BN(1_000_000_000);
  const [a, b] = shape.reversed ? [keys.mints.no, keys.mints.yes] : [keys.mints.yes, keys.mints.no];
  const prepared = cp.preparePoolCreationParams({ tokenAAmount: one, tokenBAmount: one, minSqrtPrice: shape.sqrtMin, maxSqrtPrice: shape.sqrtMax, collectFeeMode: shape.mode } as never);
  // At another start price, size the liquidity so neither side needs more than the squatter holds.
  const start = shape.start ?? prepared.initSqrtPrice;
  const liquidity = BN.min(getLiquidityDeltaFromAmountA(one, start, shape.sqrtMax, shape.mode), getLiquidityDeltaFromAmountB(one, shape.sqrtMin, start, shape.mode));
  const nft = Keypair.generate();
  const { tx, pool } = await cp.createCustomPool({
    payer: attacker.publicKey,
    creator: shape.creator.publicKey, // unsigned: the position NFT lands in that wallet
    positionNft: nft.publicKey,
    tokenAMint: a,
    tokenBMint: b,
    tokenAAmount: one,
    tokenBAmount: one,
    sqrtMinPrice: shape.sqrtMin,
    sqrtMaxPrice: shape.sqrtMax,
    initSqrtPrice: start,
    liquidityDelta: shape.start ? liquidity : prepared.liquidityDelta,
    poolFees: marketPoolFees(),
    hasAlphaVault: false,
    activationType: ACTIVATION_TYPE,
    collectFeeMode: shape.mode,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: false,
  });
  assert.ok(pool.equals(keys.pool), "the squatter's pool sits at the address the app derives");
  await sendAndConfirm(connection, built(tx, attacker.publicKey, [nft]), [attacker]);
}

const recordFor = (keys: MarketKeys, predictionId: string) => ({
  mint: coinMint.toBase58(),
  predictionId,
  oracle: oracle.publicKey.toBase58(),
  questionId: Buffer.from(keys.questionId).toString("hex"),
  question: keys.question.toBase58(),
  vault: keys.vault.toBase58(),
  mints: { yes: keys.mints.yes.toBase58(), no: keys.mints.no.toBase58() },
  pool: keys.pool.toBase58(),
  signature: "",
  lockAt: Date.now() + 600_000,
  source: "",
});

/** The create gives up for good without sending anything, and a record naming the pool can't quote or trade. */
async function refused(keys: MarketKeys, predictionId: string, readError: RegExp) {
  const server = await import("../../src/server/markets");
  const before = await connection.getBalance(oracle.publicKey);
  await assert.rejects(
    server.createMarket({ mint: coinMint.toBase58(), predictionId, ticker: "test", seedSol: "0.05" }),
    (error: Error) => error instanceof server.MarketUnavailableError && /Someone else made a pool/.test(error.message),
  );
  assert.equal(await connection.getBalance(oracle.publicKey), before, "the oracle sent nothing more");
  const record = recordFor(keys, predictionId);
  const buy = { mint: record.mint, predictionId, side: "yes" as const, action: "buy" as const, amount: "0.005", slippageBps: 100 };
  await assert.rejects(server.getMarket(record, null, Date.now()), readError);
  await assert.rejects(server.previewMarketTrade(record, buy, Date.now()), readError);
  await assert.rejects(server.buildMarketTradeForWallet(record, { ...buy, wallet: victim.publicKey.toBase58() }, Date.now()), readError);
}

test("a market's addresses can't be worked out from the coin and the prediction id", () => {
  const ours = marketKeys(connection, SECRET, coinMint, "42", oracle.publicKey);
  const guess = marketKeysFromId(connection, new Uint8Array(createHash("sha256").update(`memestream:market:v1:${coinMint.toBase58()}:42`).digest()), oracle.publicKey);
  assert.ok(!guess.question.equals(ours.question) && !guess.pool.equals(ours.pool));
});

test("a squat with the tokens reversed and a wide range is refused: no create, no trades", async () => {
  const keys = await squatStart("42");
  await squatPool(keys, { reversed: true, creator: attacker, sqrtMin: MIN_SQRT_PRICE, sqrtMax: MAX_SQRT_PRICE, start: null, mode: CollectFeeMode.BothToken });
  const pool = await loadMarketPool(connection, keys);
  assert.ok(pool);
  assert.throws(() => verifyMarketPool(keys, pool), /doesn't match memestream's/, "the pool check refuses reversed tokens");
  await refused(keys, "42", /doesn't match memestream's/);
});

test("a gift squat (our range, fee and mode, another start price, our oracle as creator) is refused: no create, no trades", async () => {
  const keys = await squatStart("43");
  await squatPool(keys, { reversed: false, creator: oracle, sqrtMin: PRICE_RANGE.min, sqrtMax: PRICE_RANGE.max, start: getSqrtPriceFromPrice("9", 9, 9), mode: COLLECT_FEE_MODE });
  const pool = await loadMarketPool(connection, keys);
  assert.ok(pool);
  assert.doesNotThrow(() => verifyMarketPool(keys, pool), "the gift squat copies every pool parameter we check");
  await refused(keys, "43", /wasn't made by memestream/);
});
