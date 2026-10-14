import type { Connection, PublicKey } from "@solana/web3.js";

/** A token account's amount (u64 at byte 64), or 0 if the data is too short. */
const amountOf = (data: Buffer) => (data.length >= 72 ? data.readBigUInt64LE(64) : BigInt(0));

/**
 * Whether `owner` holds at least `minAtoms` of any one of `mints` (summed over every token account it
 * owns, not only its associated ones: shares moved to another account still count): one RPC call per
 * mint, stopping at the first hit.
 */
export async function holdsAnyOf(connection: Pick<Connection, "getTokenAccountsByOwner">, owner: PublicKey, mints: PublicKey[], minAtoms = BigInt(1)): Promise<boolean> {
  for (const mint of mints) {
    const { value } = await connection.getTokenAccountsByOwner(owner, { mint });
    const total = value.reduce((sum, { account }) => sum + amountOf(Buffer.from(account.data)), BigInt(0));
    if (total >= minAtoms) return true;
  }
  return false;
}
