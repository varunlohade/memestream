/**
 * Which pools at a market's addresses the oracle really made. Anyone can create a DAMM v2 pool at
 * the derived address first, with our exact range and fee, any start price, and even name our oracle
 * as its (unsigned) creator. What no one else can do is create it with OUR first position: its NFT
 * keypair comes from the server secret (positionNftFor), and pool creation needs that keypair to sign.
 * So the pool is ours only if that exact position is in it, held by the oracle.
 */
import { createHmac } from "node:crypto";
import { CpAmm, derivePositionAddress, derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
import { type Connection, Keypair, type PublicKey } from "@solana/web3.js";
import { MIN_MARKET_SECRET_CHARS } from "./math";
import type { MarketKeys } from "./pool";

/** The position NFT the oracle's pool is created with: known only to the server. */
export function positionNftFor(secret: string, questionId: Uint8Array): Keypair {
  if (secret.length < MIN_MARKET_SECRET_CHARS) throw new Error("Market secret is too short");
  const seed = createHmac("sha256", secret).update(`memestream:market:position:v2:${Buffer.from(questionId).toString("hex")}:pool`).digest();
  return Keypair.fromSeed(seed);
}

/** "missing" (no pool yet), "ours" (our position is in the pool and the oracle holds its NFT), or "theirs" (someone else made it). */
export type PoolOwnership = "ours" | "missing" | "theirs";

/** Who made the market's pool. One RPC call. */
export async function poolOwnership(connection: Connection, keys: MarketKeys, nft: PublicKey): Promise<PoolOwnership> {
  const [pool, position, nftAccount] = await connection.getMultipleAccountsInfo([keys.pool, derivePositionAddress(nft), derivePositionNftAccount(nft)]);
  if (!pool) return "missing";
  let inPool = false;
  try {
    inPool = Boolean(position) && (new CpAmm(connection)._program.coder.accounts.decode("position", position!.data) as { pool: PublicKey }).pool.equals(keys.pool);
  } catch {
    inPool = false;
  }
  // NFT token account: owner @32, amount u64 @64 (Token-2022 base layout).
  const held = Boolean(nftAccount) && nftAccount!.data.length >= 72 && keys.oracle.toBuffer().equals(nftAccount!.data.subarray(32, 64)) && nftAccount!.data.readBigUInt64LE(64) === BigInt(1);
  return inPool && held ? "ours" : "theirs";
}
