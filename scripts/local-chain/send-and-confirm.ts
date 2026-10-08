/** LOCAL DEV AND TESTS ONLY: sign a built transaction with local keypairs, send it, wait for it. */
import type { Connection, Keypair } from "@solana/web3.js";
import { pollUntil } from "../../src/lib/poll";
import type { BuiltTx } from "../../src/lib/dbc/tx";
import { signatureStatus } from "../../src/lib/tx-status";

const CONFIRM = { timeoutMs: 30_000, intervalMs: 100 };

/** Signs with the given wallets plus the builder's own local signers, sends, and waits for an outcome. */
export async function sendAndConfirm(connection: Connection, built: BuiltTx, wallets: Keypair[]): Promise<string> {
  if (!wallets.some((w) => w.publicKey.equals(built.feePayer))) {
    throw new Error(`Fee payer ${built.feePayer.toBase58()} is not among the signing wallets`);
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  built.tx.recentBlockhash = blockhash;
  built.tx.sign(...wallets, ...built.localSigners);
  const signature = await connection.sendRawTransaction(built.tx.serialize());

  const outcome = await pollUntil(async () => {
    const result = await signatureStatus(connection, { signature, blockhash });
    return result.status === "pending" ? undefined : result;
  }, CONFIRM);
  if (!outcome) throw new Error(`No outcome within ${CONFIRM.timeoutMs} ms: ${signature}`);
  if (outcome.status !== "confirmed") throw new Error(`Transaction ${outcome.status}: ${outcome.error ?? signature}`);
  return signature;
}
