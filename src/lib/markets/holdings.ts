import type { Connection, PublicKey } from "@solana/web3.js";

/** A token account's amount (u64 at byte 64) is above zero. */
const holdsSome = (data: Buffer) => data.length >= 72 && data.readBigUInt64LE(64) > BigInt(0);

/**
 * Whether `owner` holds any of `mints` in any token account it owns, not only its associated ones
 * (shares moved to another account still count): one RPC call per mint, stopping at the first hit.
 */
export async function holdsAnyOf(connection: Pick<Connection, "getTokenAccountsByOwner">, owner: PublicKey, mints: PublicKey[]): Promise<boolean> {
  for (const mint of mints) {
    const { value } = await connection.getTokenAccountsByOwner(owner, { mint });
    if (value.some(({ account }) => holdsSome(Buffer.from(account.data)))) return true;
  }
  return false;
}
