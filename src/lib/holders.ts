/**
 * A coin's holder list from raw RPC answers: token accounts (owner and amount) and the mint's
 * total supply. Browser-safe.
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

/** SPL token account layout: amount (u64) follows the owner. */
const AMOUNT_OFFSET = 64;
/** The slice of a token account that holds owner and amount, for a `dataSlice` read. */
export const OWNER_AMOUNT_SLICE = { offset: OWNER_OFFSET, length: AMOUNT_OFFSET + 8 - OWNER_OFFSET };

/** Owner and amount from a token account read with OWNER_AMOUNT_SLICE. */
export function slicedOwnerAmount(slice: Uint8Array): TokenBalance {
  if (slice.length < OWNER_AMOUNT_SLICE.length) return { owner: null, amount: BigInt(0) };
  const amount = new DataView(slice.buffer, slice.byteOffset + 32, 8).getBigUint64(0, true);
  return { owner: bs58.encode(slice.subarray(0, 32)), amount };
}

export function mintSupply(data: Uint8Array | null): bigint | null {
  if (!data || data.length < SUPPLY_OFFSET + 8) return null;
  return new DataView(data.buffer, data.byteOffset + SUPPLY_OFFSET, 8).getBigUint64(0, true);
}

/** Owners with a role: the curve's and the Meteora pool's vault authorities, and the streamer. */
export type HolderRoles = { curve: string; pool: string; streamer: string };

/** One token account's balance (base units) and its owner (null if unknown). */
export type TokenBalance = { owner: string | null; amount: bigint };

/**
 * Largest holders first, one row per owner (an owner's token accounts are added up), with the share
 * of total supply; at most `limit` rows. Accounts with no balance or an unknown owner are left out.
 */
export function toHolders(balances: TokenBalance[], supply: bigint, roles: HolderRoles, limit = 20): HolderView[] {
  if (supply <= BigInt(0)) return [];
  const byOwner = new Map<string, bigint>();
  for (const { owner, amount } of balances) {
    if (owner && amount > BigInt(0)) byOwner.set(owner, (byOwner.get(owner) ?? BigInt(0)) + amount);
  }
  const role = (owner: string): HolderView["role"] =>
    owner === roles.curve ? "curve" : owner === roles.pool ? "pool" : owner === roles.streamer ? "streamer" : null;
  return [...byOwner]
    .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))
    .slice(0, limit)
    .map(([owner, amount]) => ({ owner, percent: Number((amount * BigInt(1_000_000)) / supply) / 10_000, role: role(owner) }));
}

/** What the holders list says when it has no rows to show: loading, a failed load (polling retries it), or none yet. Null with rows (stale ones stay on screen). */
export function holdersNote(holders: HolderView[] | null, error: string | null): string | null {
  if (holders) return holders.length === 0 ? "No holders yet." : null;
  return error ? "Couldn't load holders. Retrying…" : "Loading holders";
}
