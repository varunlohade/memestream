import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import type { HolderView } from "./api-types";
import { holdersNote, mintSupply, OWNER_AMOUNT_SLICE, slicedOwnerAmount, tokenAccountOwner, toHolders } from "./holders";

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
/** A token account's data: mint, owner, amount (the rest of the layout isn't read). */
const tokenAccount = (owner: number) => {
  const data = new Uint8Array(165);
  data.fill(9, 0, 32);
  data.fill(owner, 32, 64);
  return data;
};
const mint = (supply: bigint) => {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setBigUint64(36, supply, true);
  return data;
};
const roles = { curve: key(1), pool: key(2), streamer: key(3) };

test("reads a token account's owner and a mint's supply from raw data", () => {
  assert.equal(tokenAccountOwner(tokenAccount(7)), key(7));
  assert.equal(tokenAccountOwner(new Uint8Array(40)), null);
  assert.equal(tokenAccountOwner(null), null);
  assert.equal(mintSupply(mint(BigInt("1000000000000000"))), BigInt("1000000000000000"));
  assert.equal(mintSupply(new Uint8Array(10)), null);
});

test("reads owner and amount from a sliced token account read", () => {
  const full = tokenAccount(7);
  new DataView(full.buffer).setBigUint64(64, BigInt(123456789), true);
  const slice = full.slice(OWNER_AMOUNT_SLICE.offset, OWNER_AMOUNT_SLICE.offset + OWNER_AMOUNT_SLICE.length);
  assert.deepEqual(slicedOwnerAmount(slice), { owner: key(7), amount: BigInt(123456789) });
  assert.deepEqual(slicedOwnerAmount(new Uint8Array(8)), { owner: null, amount: BigInt(0) });
});

/** Largest-accounts answers plus account data, as the server joins them. */
const balances = (accounts: { amount: string }[], data: (Uint8Array | null)[]) =>
  accounts.map((a, i) => ({ owner: tokenAccountOwner(data[i]), amount: BigInt(a.amount) }));

test("holders: largest first, share of supply, roles for curve, pool and streamer", () => {
  const accounts = [
    { address: "a", amount: "800" },
    { address: "b", amount: "30" },
    { address: "c", amount: "150" },
    { address: "d", amount: "20" },
  ];
  const data = [tokenAccount(1), tokenAccount(3), tokenAccount(4), tokenAccount(2)];
  assert.deepEqual(toHolders(balances(accounts, data), BigInt(1000), roles), [
    { owner: key(1), percent: 80, role: "curve" },
    { owner: key(4), percent: 15, role: null },
    { owner: key(3), percent: 3, role: "streamer" },
    { owner: key(2), percent: 2, role: "pool" },
  ]);
});

test("holders: one row per owner, empty and unknown accounts dropped, fractions kept", () => {
  const accounts = [
    { address: "a", amount: "1" },
    { address: "b", amount: "2" },
    { address: "c", amount: "0" },
    { address: "d", amount: "500" },
  ];
  const holders = toHolders(balances(accounts, [tokenAccount(5), tokenAccount(5), tokenAccount(6), null]), BigInt(3000), roles);
  assert.deepEqual(holders, [{ owner: key(5), percent: 0.1, role: null }]);
});

test("holders: no supply means no list; the list stops at the limit", () => {
  assert.deepEqual(toHolders([{ owner: key(5), amount: BigInt(5) }], BigInt(0), roles), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ owner: key(i + 10), amount: BigInt(i + 1) }));
  const top = toHolders(many, BigInt(1000), roles, 10);
  assert.equal(top.length, 10);
  assert.equal(top[0].owner, key(39));
});

test("holdersNote: loading, a failed load (retrying), none yet; stale rows stay on screen after a failed poll", () => {
  const row = { owner: "o", percent: 1 } as HolderView;
  assert.equal(holdersNote(null, null), "Loading holders");
  assert.equal(holdersNote(null, "HTTP 500"), "Couldn't load holders. Retrying…");
  assert.equal(holdersNote([], null), "No holders yet.");
  assert.equal(holdersNote([row], "HTTP 500"), null, "the last good list stays");
});
