/**
 * The little Solana the daily stream job needs, with no npm dependencies: base58, an ed25519 keypair from
 * a base58 secret key, a devnet JSON-RPC client, and signing a transaction the site built.
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** memestream's devnet DBC config: every coin the devnet site launches uses it. */
export const DEVNET_CONFIG = "Buiw2JGkLJKgUcYPhsJ64L8x6xANqzHFxxnuc31mWyVg";

/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519_SEED = Buffer.from("302e020100300506032b657004220420", "hex");
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(text) {
  let n = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error("not base58");
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * A keypair from a base58 64-byte secret key (seed + public key, as Phantom and solana-keygen
 * export it). Throws a message that never includes the key. `sign(bytes)` returns a 64-byte signature.
 */
export function keypairFromSecret(secret) {
  let bytes;
  try {
    bytes = base58Decode(String(secret ?? "").trim());
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length !== 64) throw new Error("DAILY_STREAMER_KEY must be a base58 64-byte secret key");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_SEED, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const derived = createPublicKey(privateKey).export({ format: "jwk" }).x;
  if (derived !== Buffer.from(bytes.subarray(32)).toString("base64url")) throw new Error("DAILY_STREAMER_KEY: its public half does not match its seed");
  return { publicKey: base58Encode(bytes.slice(32)), publicKeyBytes: bytes.slice(32), sign: (data) => new Uint8Array(sign(null, data, privateKey)) };
}

function readShortVec(bytes, at) {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const b = bytes[at + i];
    if (b === undefined) throw new Error("truncated transaction");
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value, next: at + i + 1 };
  }
  throw new Error("bad transaction length prefix");
}

/** A wire transaction's parts: signature slots, the signed message, its signer count and account keys (base58). */
export function parseTransaction(bytes) {
  const sigs = readShortVec(bytes, 0);
  const messageAt = sigs.next + 64 * sigs.value;
  const message = bytes.subarray(messageAt);
  const headerAt = message[0] & 0x80 ? 1 : 0; // a versioned message starts with 0x80 | version
  const numSigners = message[headerAt];
  const keys = readShortVec(message, headerAt + 3);
  const accountKeys = [];
  for (let i = 0; i < keys.value; i++) {
    const start = keys.next + 32 * i;
    if (start + 32 > message.length) throw new Error("truncated transaction");
    accountKeys.push(base58Encode(message.subarray(start, start + 32)));
  }
  if (numSigners !== sigs.value || numSigners < 1 || numSigners > accountKeys.length) throw new Error("bad transaction header");
  return { signaturesAt: sigs.next, numSigners, message, accountKeys, feePayer: accountKeys[0] };
}

/** Puts the keypair's signature in its slot; refuses a transaction that does not ask it to sign. */
export function signTransaction(bytes, keypair) {
  const tx = parseTransaction(bytes);
  const index = tx.accountKeys.indexOf(keypair.publicKey);
  if (index < 0 || index >= tx.numSigners) throw new Error("the streamer is not a signer of this transaction");
  const out = Uint8Array.from(bytes);
  out.set(keypair.sign(tx.message), tx.signaturesAt + 64 * index);
  return out;
}

/** A tiny JSON-RPC client over `fetch`. */
export function rpcClient(url, doFetch = fetch) {
  let id = 0;
  return async function rpc(method, params = []) {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (json.error) throw new Error(`RPC ${method}: ${json.error.message ?? "error"}`);
    if (!res.ok || !("result" in json)) throw new Error(`RPC ${method}: HTTP ${res.status}`);
    return json.result;
  };
}
