import { test } from "node:test";
import assert from "node:assert/strict";
import type { PositionState } from "@meteora-ag/cp-amm-sdk";
import { type AccountInfo, Keypair, type PublicKey } from "@solana/web3.js";
import { heldPositions, type LpPosition } from "./positions";

const key = () => Keypair.generate().publicKey;
const owner = key();
const stranger = key();

/** A token account holding one NFT for `holder` (mint 0..32, owner 32..64, amount @64). */
function nftAccount(holder: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  holder.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(BigInt(1), 64);
  return { data, executable: false, lamports: 1, owner: key() };
}

const pool = (n: number) => Array.from({ length: n }, () => ({ publicKey: key(), account: { nftMint: key() } as unknown as PositionState }));

/** A fake RPC that refuses more than 100 keys, like the real one, and answers per position. */
function rpc(answer: (i: number) => AccountInfo<Buffer> | null) {
  const calls: number[] = [];
  let offset = 0;
  return {
    calls,
    connection: {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        if (keys.length > 100) throw new Error("maximum 100 accounts");
        calls.push(keys.length);
        const start = offset;
        offset += keys.length;
        return keys.map((_, k) => answer(start + k));
      },
    },
  };
}

test("a pool with 101 positions is read in chunks of at most 100, in order, and the extra call is charged", async () => {
  const positions = pool(101);
  const { connection, calls } = rpc((i) => nftAccount(i === 0 || i === 100 ? owner : stranger));
  const charged: number[] = [];
  const held = await heldPositions(connection, positions, owner, async (n) => void charged.push(n), async () => assert.fail("no NFT moved: no wallet scan"));
  assert.deepEqual(calls, [100, 1]);
  assert.deepEqual(charged, [1]);
  assert.deepEqual(held.map((p) => p.position.toBase58()), [positions[0].publicKey.toBase58(), positions[100].publicKey.toBase58()]);
});

test("a moved NFT next to one still in place: the wallet scan runs and both are kept, once each", async () => {
  const positions = pool(3);
  // #0 still in place (ours), #1 moved (its original account is empty), #2 someone else's.
  const { connection } = rpc((i) => (i === 0 ? nftAccount(owner) : i === 1 ? null : nftAccount(stranger)));
  const asFound = (i: number): LpPosition => ({ position: positions[i].publicKey, positionNftAccount: key(), positionState: positions[i].account });
  let scans = 0;
  const held = await heldPositions(connection, positions, owner, async () => {}, async () => {
    scans++;
    return [asFound(1), asFound(0)]; // the scan also finds #0: no duplicate
  });
  assert.equal(scans, 1);
  assert.deepEqual(held.map((p) => p.position.toBase58()), [positions[0].publicKey.toBase58(), positions[1].publicKey.toBase58()]);
});

test("no positions in the pool: no reads at all", async () => {
  const { connection, calls } = rpc(() => null);
  assert.deepEqual(await heldPositions(connection, [], owner, async () => {}, async () => []), []);
  assert.deepEqual(calls, []);
});
