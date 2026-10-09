import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import bs58 from "bs58";
import { MESSAGE_TTL_MS, sessionMessage } from "@/lib/predictions/message";
import { bearer, issueToken, SESSION_TTL_MS, verifySessionMessage, walletFromToken } from "./identity";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const DOMAIN = "memestream.lol";
const SECRET = "test-secret-test-secret-test-secret";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { address: bs58.encode(raw), sign: (text: string) => bs58.encode(sign(null, Buffer.from(text), privateKey)) };
}

const message = (wallet: string) => sessionMessage({ domain: DOMAIN, wallet, nonce: "0123456789abcdef0123456789abcdef", expiresAt: NOW + MESSAGE_TTL_MS });

test("a wallet's own signature verifies", () => {
  const me = keypair();
  const text = message(me.address);
  const result = verifySessionMessage(text, me.sign(text), NOW, DOMAIN);
  assert.ok(result.ok);
  assert.equal(result.request.wallet, me.address);
});

test("a signature by another wallet is refused (can't claim someone else's address)", () => {
  const me = keypair();
  const other = keypair();
  const text = message(other.address);
  assert.deepEqual(verifySessionMessage(text, me.sign(text), NOW, DOMAIN), { ok: false, error: "Bad signature" });
});

test("an expired or changed message is refused even with a good signature; junk signatures are refused", () => {
  const me = keypair();
  const text = message(me.address);
  assert.equal(verifySessionMessage(text, me.sign(text), NOW + MESSAGE_TTL_MS, DOMAIN).ok, false);
  assert.equal(verifySessionMessage(text.replace("0123", "4567"), me.sign(text), NOW, DOMAIN).ok, false);
  assert.equal(verifySessionMessage(text, "0OIl", NOW, DOMAIN).ok, false);
  assert.equal(verifySessionMessage(text, bs58.encode(new Uint8Array(64)), NOW, DOMAIN).ok, false);
});

test("session token: issued, verified, and refused once expired", () => {
  const { token, expiresAt } = issueToken("WalletA", NOW, SECRET);
  assert.equal(expiresAt, NOW + SESSION_TTL_MS);
  assert.equal(walletFromToken(token, NOW, SECRET), "WalletA");
  assert.equal(walletFromToken(token, expiresAt - 1, SECRET), "WalletA");
  assert.equal(walletFromToken(token, expiresAt, SECRET), null);
});

test("session token: forged, edited or wrong-secret tokens are refused", () => {
  const { token } = issueToken("WalletA", NOW, SECRET);
  const [, expires, mac] = token.split(".");
  assert.equal(walletFromToken(`WalletB.${expires}.${mac}`, NOW, SECRET), null, "other wallet, same mac");
  assert.equal(walletFromToken(`WalletA.${Number(expires) + 1}.${mac}`, NOW, SECRET), null, "longer expiry");
  assert.equal(walletFromToken(token, NOW, "another-secret-another-secret-xx"), null);
  for (const junk of ["", "a.b", "a.b.c.d", `${token}x`, null, undefined]) assert.equal(walletFromToken(junk, NOW, SECRET), null);
});

test("bearer: reads the token from the Authorization header only", () => {
  const request = (value?: string) => new Request("http://x/", { headers: value ? { authorization: value } : {} });
  assert.equal(bearer(request("Bearer abc.def.ghi")), "abc.def.ghi");
  assert.equal(bearer(request("Basic abc")), null);
  assert.equal(bearer(request()), null);
});
