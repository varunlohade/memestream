/**
 * Proves a wallet signed a prediction message: an ed25519 check against the wallet address
 * itself (a Solana address is its ed25519 public key). Uses Node's built-in crypto, no extra
 * dependency. The wallet comes from inside the signed text, never from a separate field.
 */
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { parseStakeMessage, type StakeRequest } from "@/lib/predictions/message";

export type Verified = { ok: true; request: StakeRequest } | { ok: false; error: string };

/** True if `signature` (64 bytes) is `publicKey`'s (32 bytes) ed25519 signature over `message`. */
export function isSignedBy(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") }, format: "jwk" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** Parses the message, checks its expiry at `now`, and checks the signature is the named wallet's. */
export function verifyStake(message: string, signatureBase58: string, now: number): Verified {
  const parsed = parseStakeMessage(message, now);
  if (!parsed.ok) return parsed;
  let signature: Uint8Array;
  try {
    signature = bs58.decode(signatureBase58);
  } catch {
    return { ok: false, error: "Bad signature" };
  }
  const signed = isSignedBy(new TextEncoder().encode(message), signature, bs58.decode(parsed.request.wallet));
  return signed ? parsed : { ok: false, error: "Bad signature" };
}
