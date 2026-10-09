/**
 * Who is playing. A wallet signs one session message (nonce + expiry); the server checks the
 * ed25519 signature against the wallet address itself (a Solana address is its public key) and
 * answers with a short-lived session token: the wallet and an expiry, HMAC-signed with a server
 * secret. Every later call carries the token; a wallet address the client merely claims is never
 * trusted. Node's built-in crypto only, no extra dependency.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import bs58 from "bs58";
import { parseSessionMessage, type SessionRequest } from "@/lib/predictions/message";

/** A session lasts this long; then the wallet signs in again. */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

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

/** Parses the session message, checks its expiry at `now`, and checks the signature is the named wallet's. */
export function verifySessionMessage(message: string, signatureBase58: string, now: number): { ok: true; request: SessionRequest } | { ok: false; error: string } {
  const parsed = parseSessionMessage(message, now);
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

const mac = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** "<wallet>.<expires ms>.<hmac>". */
export function issueToken(wallet: string, now: number, secret: string): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_TTL_MS;
  const payload = `${wallet}.${expiresAt}`;
  return { token: `${payload}.${mac(payload, secret)}`, expiresAt };
}

/** The token's wallet, or null if it is malformed, forged or expired at `now`. */
export function walletFromToken(token: string | null | undefined, now: number, secret: string): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [wallet, expires, signature] = parts;
  const expected = Buffer.from(mac(`${wallet}.${expires}`, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!/^\d{1,15}$/.test(expires) || Number(expires) <= now) return null;
  return wallet;
}

/** The token from an `Authorization: Bearer <token>` header. */
export const bearer = (request: Request) => /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
