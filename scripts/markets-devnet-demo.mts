/**
 * DEVNET ONLY: one prediction market's full life on real devnet, as small as it can be.
 * The oracle (.keys/partner.json) creates and seeds a market, .keys/e2e-viewer-1.json buys YES and
 * sells half of it, the oracle closes trading and resolves YES, then both redeem.
 *
 *   npx tsx scripts/markets-devnet-demo.mts                     a new market
 *   MARKET_QUESTION=<address> npx tsx scripts/markets-devnet-demo.mts   finish an earlier one
 *
 * Each step runs only if the market still needs it, so a stopped run can be finished without
 * paying for a second market. Prints every signature and the SOL each wallet spent.
 */
import { randomBytes } from "node:crypto";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { solToLamports } from "../src/lib/dbc/units";
import { lpPositionsOf } from "../src/lib/damm/positions";
import { buildCreateMarketTxs, buildMarketMetadataTx } from "../src/lib/markets/create";
import { positionNfts } from "../src/lib/markets/provenance";
import { loadMarketPools, type MarketKeys, marketKeys, marketKeysFromId, marketOdds } from "../src/lib/markets/pool";
import { buildCloseTradingTxs, buildRedeemTx, buildResolveTx } from "../src/lib/markets/settle";
import { isTradingOpen, prepareMarketTrade } from "../src/lib/markets/trade";
import { fetchQuestion } from "../src/lib/markets/vault";
import { connectToDevnet } from "./devnet";
import { readKeypair } from "./keys";
import { sendAndConfirm } from "./local-chain/send-and-confirm";

/** SOL on each pool's wSOL side; the whole seed is ~2.6x this, and comes back at redemption. */
const SEED_PER_POOL = "0.02";
/** Below the ~0.0087 SOL that takes a 0.02-seeded side from 0.5 to 1. */
const BET = "0.005";

const connection = await connectToDevnet();
const oracle = readKeypair(".keys/partner.json");
const viewer = readKeypair(".keys/e2e-viewer-1.json");
const sol = async (who: Keypair) => (await connection.getBalance(who.publicKey)) / LAMPORTS_PER_SOL;
const step = (label: string, signature: string) => console.log(`${label.padEnd(14)} ${signature}`);

const [oracleStart, viewerStart] = [await sol(oracle), await sol(viewer)];
console.log(`oracle ${oracle.publicKey.toBase58()} ${oracleStart} SOL; viewer ${viewer.publicKey.toBase58()} ${viewerStart} SOL`);
if (oracleStart < 0.1 || viewerStart < 0.01) throw new Error("Not enough devnet SOL; fund the wallets first.");

async function market(): Promise<MarketKeys> {
  const resume = process.env.MARKET_QUESTION;
  if (resume) {
    const question = await fetchQuestion(connection, new PublicKey(resume));
    if (!question?.oracle.equals(oracle.publicKey)) throw new Error("No market of this oracle at MARKET_QUESTION");
    return marketKeysFromId(connection, question.questionId, oracle.publicKey);
  }
  // A throwaway coin address: the market only uses it to derive its question id.
  const secret = randomBytes(32).toString("hex");
  const keys = marketKeys(connection, secret, Keypair.generate().publicKey, "1", oracle.publicKey);
  const names = { yes: { name: "$DEMO #1 YES", symbol: "YES", uri: "" }, no: { name: "$DEMO #1 NO", symbol: "NO", uri: "" } };
  const created = await buildCreateMarketTxs(connection, keys, solToLamports(SEED_PER_POOL), positionNfts(secret, keys.questionId));
  for (const [i, tx] of created.entries()) step(["create", "split", "pool YES", "pool NO"][i], await sendAndConfirm(connection, tx, [oracle]));
  step("names", await sendAndConfirm(connection, await buildMarketMetadataTx(connection, keys, names), [oracle]));
  return keys;
}

const keys = await market();
console.log(`question ${keys.question.toBase58()}\nYES mint ${keys.mints.yes.toBase58()} pool ${keys.pools.yes.toBase58()}\nNO mint ${keys.mints.no.toBase58()} pool ${keys.pools.no.toBase58()}`);

const pools = async () => {
  const loaded = await loadMarketPools(connection, keys);
  if (!loaded) throw new Error("Market pools missing");
  return loaded;
};
const yesHeld = async () =>
  new BN((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(keys.mints.yes, viewer.publicKey)).catch(() => null))?.value.amount ?? "0");

if (isTradingOpen(await pools())) {
  console.log("odds", JSON.stringify(marketOdds(await pools()).probability));
  if ((await yesHeld()).isZero()) {
    const buy = await prepareMarketTrade(connection, await pools(), viewer.publicKey, { side: "yes", action: "buy", amount: solToLamports(BET) }, 100);
    step("buy YES", await sendAndConfirm(connection, buy, [viewer]));
    console.log("odds after buy", JSON.stringify(marketOdds(await pools()).probability));
    const sell = await prepareMarketTrade(connection, await pools(), viewer.publicKey, { side: "yes", action: "sell", amount: (await yesHeld()).divn(2) }, 100);
    step("sell YES", await sendAndConfirm(connection, sell, [viewer]));
  }
  for (const tx of await buildCloseTradingTxs(connection, keys, await pools())) step("close", await sendAndConfirm(connection, tx, [oracle]));
}
const leftover = await Promise.all([lpPositionsOf(connection, keys.pools.yes, oracle.publicKey), lpPositionsOf(connection, keys.pools.no, oracle.publicKey)]);
if (leftover.flat().length > 0) throw new Error("The oracle still has liquidity in a pool");

if (!(await fetchQuestion(connection, keys.question))?.resolved) {
  step("resolve YES", await sendAndConfirm(connection, await buildResolveTx(connection, keys, "yes"), [oracle]));
}
for (const [label, who] of [["redeem viewer", viewer], ["redeem oracle", oracle]] as const) {
  const built = await buildRedeemTx(connection, keys, who.publicKey).catch((error: Error) => {
    if (/holds no YES or NO/.test(error.message)) return null;
    throw error;
  });
  if (built) step(label, await sendAndConfirm(connection, built, [who]));
}

const [oracleEnd, viewerEnd] = [await sol(oracle), await sol(viewer)];
console.log(`oracle: ${(oracleStart - oracleEnd).toFixed(9)} SOL spent this run`);
console.log(`viewer: ${(viewerEnd - viewerStart).toFixed(9)} SOL this run`);
