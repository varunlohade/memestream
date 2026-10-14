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
