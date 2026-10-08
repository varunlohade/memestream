/**
 * Where a sent transaction stands. Shared by the server API, tests and scripts (not the browser).
 * "expired" means the server's blockhash is no longer valid and the signature (if any) is unseen.
 * The UI never treats that as "nothing spent" (a wallet may sign with its own blockhash); it asks
 * the user to check their wallet. Read order + slot check avoid misreading a lagging RPC node,
 * and "failed" is only reported once confirmed (a processed fork can drop).
 */
import type { Connection } from "@solana/web3.js";
import type { TxStatus } from "./api-types";

export async function signatureStatus(connection: Connection, query: { signature: string | null; blockhash: string }): Promise<TxStatus> {
  const blockhashCheck = await connection.isBlockhashValid(query.blockhash, { commitment: "confirmed" });
  if (query.signature) {
    const lookup = await connection.getSignatureStatuses([query.signature], { searchTransactionHistory: true });
    const status = lookup.value[0];
    if (status) {
      if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") return { status: "pending" };
      return status.err ? { status: "failed", error: JSON.stringify(status.err) } : { status: "confirmed" };
    }
    if (lookup.context.slot < blockhashCheck.context.slot) return { status: "pending" }; // lagging node
  }
  return blockhashCheck.value ? { status: "pending" } : { status: "expired" };
}
