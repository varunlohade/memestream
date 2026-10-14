import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { holdsAnyOf } from "./holdings";

/** A token account's data with `amount` at byte 64. */
const account = (amount: bigint) => {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return { pubkey: Keypair.generate().publicKey, account: { data, executable: false, lamports: 1, owner: Keypair.generate().publicKey } };
};

/** A fake RPC: the token accounts `owner` has per mint (any address, not only the associated one). */
function rpc(byMint: Map<string, ReturnType<typeof account>[]>) {
  const asked: string[] = [];
  const connection = {
    getTokenAccountsByOwner: async (_owner: PublicKey, filter: { mint: PublicKey }) => {
      asked.push(filter.mint.toBase58());
      return { context: { slot: 1 }, value: byMint.get(filter.mint.toBase58()) ?? [] };
    },
  } as unknown as Parameters<typeof holdsAnyOf>[0];
  return { connection, asked };
}

test("audit 1: shares count in any token account the wallet owns, not only its associated ones", async () => {
  const owner = Keypair.generate().publicKey;
  const [yes, no] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const moved = rpc(new Map([[no.toBase58(), [account(BigInt(0)), account(BigInt(5))]]]));
  assert.equal(await holdsAnyOf(moved.connection, owner, [yes, no]), true, "NO held in a second, non-associated account");
  assert.deepEqual(moved.asked, [yes.toBase58(), no.toBase58()], "filtered by each outcome mint");
  const empty = rpc(new Map([[yes.toBase58(), [account(BigInt(0))]]]));
  assert.equal(await holdsAnyOf(empty.connection, owner, [yes, no]), false, "empty accounts hold nothing");
  const first = rpc(new Map([[yes.toBase58(), [account(BigInt(1))]]]));
  assert.equal(await holdsAnyOf(first.connection, owner, [yes, no]), true);
  assert.deepEqual(first.asked, [yes.toBase58()], "stops at the first hit");
});

test("audit 3-3: a stake threshold ignores dust, summed over every account of one side", async () => {
  const owner = Keypair.generate().publicKey;
  const [yes, no] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const min = BigInt(10_000_000); // 0.01 of a share
  const dusted = rpc(new Map([[yes.toBase58(), [account(BigInt(1))]], [no.toBase58(), [account(BigInt(5))]]]));
  assert.equal(await holdsAnyOf(dusted.connection, owner, [yes, no], min), false, "dust is no stake");
  assert.equal(await holdsAnyOf(dusted.connection, owner, [yes, no]), true, "but it is some shares");
  const split = rpc(new Map([[no.toBase58(), [account(BigInt(6_000_000)), account(BigInt(4_000_000))]]]));
  assert.equal(await holdsAnyOf(split.connection, owner, [yes, no], min), true, "a stake split over two accounts counts");
});
