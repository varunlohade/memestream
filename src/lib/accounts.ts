/** Reading many accounts: the RPC's getMultipleAccounts takes at most 100 keys per call. */
import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { chunks } from "./chunks";

export const MAX_ACCOUNTS_PER_CALL = 100;

/** RPC calls needed to read `count` accounts. */
export const accountReadCalls = (count: number) => Math.ceil(count / MAX_ACCOUNTS_PER_CALL);

/** Every account, in the order given, in calls of at most 100 keys. */
export async function getAccountsChunked(connection: Pick<Connection, "getMultipleAccountsInfo">, keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
  const parts = await Promise.all(chunks(keys, MAX_ACCOUNTS_PER_CALL).map((part) => connection.getMultipleAccountsInfo(part)));
  return parts.flat();
}
