/** Strict base58 checks for request input, so made-up keys are refused before any RPC call. */
import bs58 from "bs58";

/** True if `text` is base58 for exactly `bytes` bytes (32 for an address or blockhash, 64 for a signature). */
export function isBase58Of(text: string, bytes: number): boolean {
  try {
    return bs58.decode(text).length === bytes;
  } catch {
    return false;
  }
}
