/** Reads a coin's on-chain Metaplex metadata (name, symbol, uri) without the Metaplex SDK. */
import "server-only";
import { deriveMintMetadata } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Connection, PublicKey } from "@solana/web3.js";
import { chunks } from "@/lib/chunks";

export type TokenMetadata = { name: string; symbol: string; uri: string };

/** Borsh string: u32 little-endian length, then bytes (Metaplex pads with NULs). */
function readString(data: Buffer, offset: number): [string, number] {
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const text = data.subarray(start, start + length).toString("utf8").replace(/\0+$/, "");
  return [text, start + length];
}

/** Layout: key (1) + update authority (32) + mint (32) + name + symbol + uri. */
const NAME_OFFSET = 1 + 32 + 32;

export function decodeMetadata(data: Buffer): TokenMetadata {
  const [name, afterName] = readString(data, NAME_OFFSET);
  const [symbol, afterSymbol] = readString(data, afterName);
  const [uri] = readString(data, afterSymbol);
  return { name, symbol, uri };
}

/** RPCs cap getMultipleAccounts at 100 keys per call, and web3.js doesn't split for us. */
export const MAX_ACCOUNTS_PER_CALL = 100;

/** Metadata for each mint, in order; one RPC call per 100 mints. */
export async function loadMetadata(connection: Connection, mints: PublicKey[]): Promise<(TokenMetadata | null)[]> {
  const calls = chunks(mints.map(deriveMintMetadata), MAX_ACCOUNTS_PER_CALL).map((keys) => connection.getMultipleAccountsInfo(keys));
  const infos = (await Promise.all(calls)).flat();
  return infos.map((info) => (info ? decodeMetadata(info.data) : null));
}

/**
 * Metadata for a mint ONLY if it's a memestream coin (its pool exists on our config), so the
 * metadata route can't brand any other token as ours. One RPC call: both accounts at once.
 */
export async function loadCoinMetadata(connection: Connection, mint: PublicKey, pool: PublicKey): Promise<TokenMetadata | null> {
  const [metadata, poolAccount] = await connection.getMultipleAccountsInfo([deriveMintMetadata(mint), pool]);
  return metadata && poolAccount ? decodeMetadata(metadata.data) : null;
}
