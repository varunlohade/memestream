/**
 * Which pools at a market's addresses the oracle really made. Anyone can create a DAMM v2 pool at
 * the derived address first, with our exact range and fee, any start price, and even name our oracle
 * as its (unsigned) creator. What no one else can do is create it with OUR first position: its NFT
 * keypair comes from the server secret (positionNftFor), and pool creation needs that keypair to sign.
 * So a pool is ours only if that exact position is in it, held by the oracle.
 */
import { createHmac } from "node:crypto";
import { CpAmm, derivePositionAddress, derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
import { type Connection, Keypair, type PublicKey } from "@solana/web3.js";
import type { Side } from "./math";
import { MIN_MARKET_SECRET_CHARS } from "./math";
import type { MarketKeys } from "./pool";

const SIDES: Side[] = ["yes", "no"];

/** The position NFT the oracle's pool for `side` is created with: known only to the server. */
export function positionNftFor(secret: string, questionId: Uint8Array, side: Side): Keypair {
  if (secret.length < MIN_MARKET_SECRET_CHARS) throw new Error("Market secret is too short");
  const seed = createHmac("sha256", secret).update(`memestream:market:position:v1:${Buffer.from(questionId).toString("hex")}:${side}`).digest();
  return Keypair.fromSeed(seed);
}

export const positionNfts = (secret: string, questionId: Uint8Array): Record<Side, Keypair> => ({
  yes: positionNftFor(secret, questionId, "yes"),
  no: positionNftFor(secret, questionId, "no"),
});

export type PoolOwnership = Record<Side, "ours" | "missing" | "theirs">;

/**
 * For each side: "missing" (no pool yet), "ours" (our position is in the pool and the oracle holds
 * its NFT), or "theirs" (a pool someone else made). One RPC call for both sides.
 */
export async function poolOwnership(connection: Connection, keys: MarketKeys, nfts: Record<Side, PublicKey>): Promise<PoolOwnership> {
  const positions = SIDES.map((side) => derivePositionAddress(nfts[side]));
  const nftAccounts = SIDES.map((side) => derivePositionNftAccount(nfts[side]));
  const infos = await connection.getMultipleAccountsInfo([keys.pools.yes, keys.pools.no, ...positions, ...nftAccounts]);
  const coder = new CpAmm(connection)._program.coder.accounts;
  const out = {} as PoolOwnership;
  SIDES.forEach((side, i) => {
    if (!infos[i]) {
      out[side] = "missing";
      return;
    }
    const position = infos[2 + i];
    const nftAccount = infos[4 + i];
    let inPool = false;
    try {
      inPool = Boolean(position) && (coder.decode("position", position!.data) as { pool: PublicKey }).pool.equals(keys.pools[side]);
    } catch {
      inPool = false;
    }
    // NFT token account: owner @32, amount u64 @64 (Token-2022 base layout).
    const held = Boolean(nftAccount) && nftAccount!.data.length >= 72 && keys.oracle.toBuffer().equals(nftAccount!.data.subarray(32, 64)) && nftAccount!.data.readBigUInt64LE(64) === BigInt(1);
    out[side] = inPool && held ? "ours" : "theirs";
  });
  return out;
}
