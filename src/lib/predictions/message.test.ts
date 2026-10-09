import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGE_TTL_MS, newNonce, parseSessionMessage, type SessionRequest, sessionMessage } from "./message";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const DOMAIN = "memestream.lol";
const request: SessionRequest = {
  domain: DOMAIN,
  wallet: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  nonce: "0123456789abcdef0123456789abcdef",
  expiresAt: NOW + MESSAGE_TTL_MS,
};

test("a built message parses back to the same request", () => {
  assert.deepEqual(parseSessionMessage(sessionMessage(request), NOW, DOMAIN), { ok: true, request });
});

test("the message reads like Sign-In-With-Solana in a wallet popup", () => {
  assert.equal(
    sessionMessage(request),
    [
      "memestream.lol wants you to sign in with your Solana account:",
      request.wallet,
      "",
      "memestream predictions: free points, no money, no prizes. Signing in costs nothing and sends nothing.",
      "",
      `Nonce: ${request.nonce}`,
      "Expiration Time: 2026-10-09T12:05:00.000Z",
    ].join("\n"),
  );
});

test("a message signed for another domain is refused", () => {
  const phished = sessionMessage({ ...request, domain: "memestream.lol.evil.example" });
  assert.deepEqual(parseSessionMessage(phished, NOW, DOMAIN), { ok: false, error: "This sign-in was made for another site" });
  assert.equal(parseSessionMessage(sessionMessage({ ...request, domain: "127.0.0.1:3000" }), NOW, "127.0.0.1:4000").ok, false, "port counts");
});

test("expiry: refused at and after the expiry, accepted just before", () => {
  const text = sessionMessage(request);
  assert.equal(parseSessionMessage(text, request.expiresAt - 1, DOMAIN).ok, true);
  assert.equal(parseSessionMessage(text, request.expiresAt, DOMAIN).ok, false);
  assert.equal(parseSessionMessage(text, request.expiresAt + 1, DOMAIN).ok, false);
});

test("expiry: refused when set too far ahead", () => {
  const far = sessionMessage({ ...request, expiresAt: NOW + 60 * 60 * 1000 });
  assert.deepEqual(parseSessionMessage(far, NOW, DOMAIN), { ok: false, error: "Expiry too far ahead. Check your clock." });
});

test("malformed or tampered messages are refused", () => {
  const text = sessionMessage(request);
  const cases = [
    text.replace(request.wallet, "not-a-wallet"),
    text.replace(request.nonce, "short"),
    text.replace(/Expiration Time: .*/, "Expiration Time: tomorrow"),
    text.replace("costs nothing", "costs 1 SOL"),
    `${text}\nExtra: line`,
    text.split("\n").slice(0, -1).join("\n"),
    text.replace("Nonce: ", "Nonce:"),
    text.replace("\n\n", "\n"),
  ];
  for (const bad of cases) assert.equal(parseSessionMessage(bad, NOW, DOMAIN).ok, false, bad);
});

test("nonces are 32 hex characters and differ", () => {
  const a = newNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newNonce());
});
