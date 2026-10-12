/**
 * Gets the oracle's seed SOL back from one market, e.g. one whose create landed but that ended
 * "failed", or whose registry entry is gone. Each step runs only if the market still needs it:
 *   1. close trading: take the oracle's liquidity out of the pool;
 *   2. resolve as a refund [1,1], only with RESOLVE=refund and only if nobody resolved it yet;
 *   3. redeem the oracle's YES/NO for SOL (once resolved).
 *
 *   MARKET_QUESTION=<question address> [RESOLVE=refund] npx tsx scripts/markets-recover.mts
 *
 * The oracle key is read from .keys/partner.json (or ORACLE_KEY_FILE); it is never printed.
 * Uses MEMESTREAM_RPC_URL (default devnet). Prints each signature.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadMarketPool, marketKeysFromId } from "../src/lib/markets/pool";
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

const pool = await loadMarketPool(connection, keys);
if (pool) {
  for (const tx of await buildCloseTradingTxs(connection, keys, pool)) console.log(`close    ${await sendAndConfirm(connection, tx, [oracle])}`);
} else {
  console.log("close    skipped: the market has no pool (nothing seeded)");
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
