import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import { mintSupply, tokenAccountOwner, toHolders } from "./holders";

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

test("holders: largest first, share of supply, roles for curve, pool and streamer", () => {
  const accounts = [
    { address: "a", amount: "800" },
    { address: "b", amount: "30" },
    { address: "c", amount: "150" },
    { address: "d", amount: "20" },
  ];
  const data = [tokenAccount(1), tokenAccount(3), tokenAccount(4), tokenAccount(2)];
  assert.deepEqual(toHolders(accounts, data, BigInt(1000), roles), [
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
  const holders = toHolders(accounts, [tokenAccount(5), tokenAccount(5), tokenAccount(6), null], BigInt(3000), roles);
  assert.deepEqual(holders, [{ owner: key(5), percent: 0.1, role: null }]);
});

test("holders: no supply means no list", () => {
  assert.deepEqual(toHolders([{ address: "a", amount: "5" }], [tokenAccount(5)], BigInt(0), roles), []);
});
