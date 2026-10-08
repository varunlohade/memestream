/** Reads a coin's on-chain Metaplex metadata (name, symbol, uri) without the Metaplex SDK. */
import "server-only";
import { deriveMintMetadata } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { Connection, PublicKey } from "@solana/web3.js";

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

export async function loadMetadata(connection: Connection, mints: PublicKey[]): Promise<(TokenMetadata | null)[]> {
  const infos = await connection.getMultipleAccountsInfo(mints.map(deriveMintMetadata));
  return infos.map((info) => (info ? decodeMetadata(info.data) : null));
}
