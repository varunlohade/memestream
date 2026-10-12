/**
 * A coin's holder list from two RPC answers: the mint's largest token accounts, and the raw data of
 * the mint plus those accounts (for the total supply and each account's owner). Browser-safe.
 */
import bs58 from "bs58";
import type { HolderView } from "./api-types";

/** SPL token account layout: mint (32 bytes), then owner (32 bytes). */
const OWNER_OFFSET = 32;
/** SPL mint layout: mint authority option (36 bytes), then supply (u64). */
const SUPPLY_OFFSET = 36;

export function tokenAccountOwner(data: Uint8Array | null): string | null {
  if (!data || data.length < OWNER_OFFSET + 32) return null;
  return bs58.encode(data.subarray(OWNER_OFFSET, OWNER_OFFSET + 32));
}

export function mintSupply(data: Uint8Array | null): bigint | null {
  if (!data || data.length < SUPPLY_OFFSET + 8) return null;
  return new DataView(data.buffer, data.byteOffset + SUPPLY_OFFSET, 8).getBigUint64(0, true);
}

/** Owners with a role: the curve's and the Meteora pool's vault authorities, and the streamer. */
export type HolderRoles = { curve: string; pool: string; streamer: string };

/**
 * Largest holders first, one row per owner (an owner's token accounts are added up), with the share
 * of total supply. Accounts with no balance or an unknown owner are left out.
 */
export function toHolders(
  accounts: { address: string; amount: string }[],
  data: (Uint8Array | null)[],
  supply: bigint,
  roles: HolderRoles,
): HolderView[] {
  if (supply <= BigInt(0)) return [];
  const byOwner = new Map<string, bigint>();
  accounts.forEach((account, i) => {
    const owner = tokenAccountOwner(data[i] ?? null);
    const amount = BigInt(account.amount);
    if (owner && amount > BigInt(0)) byOwner.set(owner, (byOwner.get(owner) ?? BigInt(0)) + amount);
  });
  const role = (owner: string): HolderView["role"] =>
    owner === roles.curve ? "curve" : owner === roles.pool ? "pool" : owner === roles.streamer ? "streamer" : null;
  return [...byOwner]
    .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))
    .map(([owner, amount]) => ({ owner, percent: Number((amount * BigInt(1_000_000)) / supply) / 10_000, role: role(owner) }));
}
