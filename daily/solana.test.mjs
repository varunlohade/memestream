import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { base58Decode, base58Encode, keypairFromSecret, parseTransaction, signTransaction } from "./solana.mjs";
import { fakeTx, newSecret } from "./test-helpers.mjs";

const pubOf = (kp) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(kp.publicKeyBytes).toString("base64url") }, format: "jwk" });

test("base58: round trips bytes, leading zeros included, and a known address", () => {
  for (const bytes of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(255), new Uint8Array([0])]) {
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  }
  assert.equal(base58Encode(new Uint8Array(32)), "11111111111111111111111111111111");
  assert.throws(() => base58Decode("0OIl"), /not base58/);
});

test("keypairFromSecret: derives the public key; bad keys fail without echoing the key", () => {
  const secret = newSecret();
  const kp = keypairFromSecret(secret);
  assert.equal(kp.publicKey, base58Encode(base58Decode(secret).slice(32)));
  const sig = kp.sign(Buffer.from("hi"));
  assert.ok(verify(null, Buffer.from("hi"), pubOf(kp), sig));
  for (const bad of ["", "abc", secret.slice(0, 40), `${secret}0`]) {
    assert.throws(() => keypairFromSecret(bad), (e) => /DAILY_STREAMER_KEY/.test(e.message) && (!bad || !e.message.includes(bad)));
  }
  const bytes = base58Decode(secret);
  bytes[40] ^= 1; // public half no longer matches the seed
  assert.throws(() => keypairFromSecret(base58Encode(bytes)), /does not match/);
});

test("signTransaction: signs the message in the streamer's slot and keeps the other signature (legacy and v0)", () => {
  const kp = keypairFromSecret(newSecret());
  const mint = keypairFromSecret(newSecret()).publicKey;
  const other = keypairFromSecret(newSecret()).publicKey;
  for (const versioned of [false, true]) {
    const raw = fakeTx([kp.publicKey, mint, other], { versioned });
    const tx = parseTransaction(raw);
    assert.equal(tx.feePayer, kp.publicKey);
    assert.deepEqual(tx.accountKeys, [kp.publicKey, mint, other]);
    const signed = signTransaction(raw, kp);
    assert.ok(verify(null, tx.message, pubOf(kp), signed.subarray(1, 65)));
    assert.deepEqual(signed.subarray(65, 129), raw.subarray(65, 129));
    assert.deepEqual(signed.subarray(129), raw.subarray(129));
  }
});

test("signTransaction: refuses a transaction the streamer is not asked to sign", () => {
  const kp = keypairFromSecret(newSecret());
  const a = keypairFromSecret(newSecret()).publicKey;
  const b = keypairFromSecret(newSecret()).publicKey;
  assert.throws(() => signTransaction(fakeTx([a, b, kp.publicKey]), kp), /not a signer/);
  assert.throws(() => signTransaction(fakeTx([a, b]), kp), /not a signer/);
  assert.throws(() => parseTransaction(new Uint8Array([1, 0, 0])), /truncated|bad/);
});
