/**
 * The last step for every transaction the server builds for a wallet: fresh blockhash, priority
 * fee (lib/priority-fee.ts), partial-sign with the builder's throwaway keypairs, remember it (the
 * localhost test wallet signs only these), and serialize. Order matters: the priority fee changes
 * the message, so it comes before any signature.
 */
import "server-only";
import type { PreparedTx } from "@/lib/api-types";
import type { BuiltTx } from "@/lib/dbc/tx";
import { addPriorityFee } from "@/lib/priority-fee";
import { getChain, priorityFee, rememberBuilt } from "./chain";

/** RPC calls the priority fee adds to each build (recent fees + one simulation). */
export const PRIORITY_FEE_RPC_CALLS = 2;

/** Sets blockhash and priority fee; returns the blockhash. The caller signs next. */
export async function finishTx(built: BuiltTx): Promise<string> {
  const { connection } = getChain();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  built.tx.recentBlockhash = blockhash;
  await addPriorityFee(connection, built.tx, priorityFee());
  return blockhash;
}

export async function toPreparedTx(built: BuiltTx): Promise<PreparedTx> {
  const blockhash = await finishTx(built);
  if (built.localSigners.length) built.tx.partialSign(...built.localSigners);
  rememberBuilt(built.tx);
  const bytes = built.tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return { transaction: bytes.toString("base64"), blockhash };
}
