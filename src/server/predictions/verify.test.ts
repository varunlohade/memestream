import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import bs58 from "bs58";
import { MESSAGE_TTL_MS, stakeMessage } from "@/lib/predictions/message";
import { verifyStake } from "./verify";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { address: bs58.encode(raw), sign: (text: string) => bs58.encode(sign(null, Buffer.from(text), privateKey)) };
}

const message = (wallet: string) =>
  stakeMessage({
    mint: "So11111111111111111111111111111111111111112",
    side: "no",
    points: 10,
    wallet,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: NOW + MESSAGE_TTL_MS,
  });

test("a wallet's own signature verifies", () => {
  const me = keypair();
  const text = message(me.address);
  const result = verifyStake(text, me.sign(text), NOW);
  assert.ok(result.ok);
  assert.equal(result.request.wallet, me.address);
});

test("a signature by another wallet is refused (can't claim someone else's address)", () => {
  const me = keypair();
  const other = keypair();
  const text = message(other.address);
  assert.deepEqual(verifyStake(text, me.sign(text), NOW), { ok: false, error: "Bad signature" });
});

test("changing any signed field breaks the signature", () => {
  const me = keypair();
  const text = message(me.address);
  const signature = me.sign(text);
  assert.equal(verifyStake(text.replace("Side: no", "Side: yes"), signature, NOW).ok, false);
  assert.equal(verifyStake(text.replace("Points: 10", "Points: 99"), signature, NOW).ok, false);
});

test("an expired message is refused even with a good signature; junk signatures are refused", () => {
  const me = keypair();
  const text = message(me.address);
  assert.equal(verifyStake(text, me.sign(text), NOW + MESSAGE_TTL_MS).ok, false);
  assert.equal(verifyStake(text, "0OIl", NOW).ok, false);
  assert.equal(verifyStake(text, bs58.encode(new Uint8Array(64)), NOW).ok, false);
});
