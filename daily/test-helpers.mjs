/** Test helpers for the daily stream job (not shipped in the image). */
import { generateKeyPairSync } from "node:crypto";
import { base58Decode, base58Encode } from "./solana.mjs";

/** A fresh ed25519 keypair as a base58 64-byte secret key (seed + public key), like solana-keygen's. */
export function newSecret() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return base58Encode(Buffer.concat([d, x]));
}

/** A wire transaction: `signers` signature slots, then a legacy (or v0) message over `keys`. */
export function fakeTx(keys, { signers = 2, versioned = false } = {}) {
  const header = [signers, 0, 1];
  const message = Buffer.concat([
    Buffer.from(versioned ? [0x80, ...header] : header),
    Buffer.from([keys.length]),
    ...keys.map((k) => Buffer.from(base58Decode(k))),
    Buffer.alloc(32, 7), // blockhash
    Buffer.from([0]), // no instructions
    ...(versioned ? [Buffer.from([0])] : []), // no lookup tables
  ]);
  const sigs = Buffer.alloc(64 * signers, 0);
  sigs.fill(9, 64); // another signer (the mint) already signed slot 1
  return Uint8Array.from(Buffer.concat([Buffer.from([signers]), sigs, message]));
}

