/**
 * Gets the oracle's seed SOL back from one market, e.g. one whose create landed but that ended
 * "failed", or whose registry entry is gone. Each step runs only if the market still needs it:
 *   1. close trading: take the oracle's own position (from MEMESTREAM_MARKET_SECRET) out of the pool;
 *      positions others opened in the oracle's name are left alone, and a squatted pool has none of ours;
 *   2. resolve as a refund [1,1], only with RESOLVE=refund and only if nobody resolved it yet;
 *   3. redeem the oracle's YES/NO for SOL (once resolved).
 *
 *   MARKET_QUESTION=<question address> MEMESTREAM_MARKET_SECRET=<the server's> [RESOLVE=refund] \
 *     npx tsx scripts/markets-recover.mts
 *
 * The oracle key is read from .keys/partner.json (or ORACLE_KEY_FILE); it is never printed.
 * Uses MEMESTREAM_RPC_URL (default devnet). Prints each signature.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { MIN_MARKET_SECRET_CHARS } from "../src/lib/markets/math";
import { loadMarketPool, marketKeysFromId } from "../src/lib/markets/pool";
import { positionNftFor } from "../src/lib/markets/provenance";
import { buildCloseTradingTxs, buildRedeemTx, buildResolveTx } from "../src/lib/markets/settle";
import { fetchQuestion } from "../src/lib/markets/vault";
import { readKeypair } from "./keys";
import { sendAndConfirm } from "./local-chain/send-and-confirm";

const question = process.env.MARKET_QUESTION;
if (!question) throw new Error("Set MARKET_QUESTION=<the market's question address>");
const connection = new Connection(process.env.MEMESTREAM_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const oracle = readKeypair(process.env.ORACLE_KEY_FILE ?? ".keys/partner.json");

const state = await fetchQuestion(connection, new PublicKey(question));
if (!state) throw new Error("No question at that address");
if (!state.oracle.equals(oracle.publicKey)) throw new Error("That market's oracle isn't this key");
const keys = marketKeysFromId(connection, state.questionId, oracle.publicKey);
const before = await connection.getBalance(oracle.publicKey);

const secret = process.env.MEMESTREAM_MARKET_SECRET ?? "";
const pool = await loadMarketPool(connection, keys);
if (!pool) console.log("close    skipped: the market has no pool (nothing seeded)");
else if (secret.length < MIN_MARKET_SECRET_CHARS) console.log("close    skipped: set MEMESTREAM_MARKET_SECRET to find the oracle's position");
else {
  const txs = await buildCloseTradingTxs(connection, keys, pool, positionNftFor(secret, keys.questionId).publicKey);
  if (txs.length === 0) console.log("close    skipped: no position of ours in the pool (closed already, or the pool isn't ours)");
  for (const tx of txs) console.log(`close    ${await sendAndConfirm(connection, tx, [oracle])}`);
}

let resolved = state.resolved;
if (!resolved && process.env.RESOLVE === "refund") {
  console.log(`resolve  ${await sendAndConfirm(connection, await buildResolveTx(connection, keys, "refund"), [oracle])}`);
  resolved = true;
}
if (resolved) {
  const redeem = await buildRedeemTx(connection, keys, oracle.publicKey).catch((error: Error) => {
    if (/holds no YES or NO/.test(error.message)) return null;
    throw error;
  });
  console.log(redeem ? `redeem   ${await sendAndConfirm(connection, redeem, [oracle])}` : "redeem   skipped: the oracle holds no YES or NO");
} else {
  console.log("redeem   waits: the market isn't resolved (set RESOLVE=refund to refund it now)");
}
console.log(`oracle ${((await connection.getBalance(oracle.publicKey)) - before) / 1e9} SOL this run`);
