import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGE_TTL_MS, newNonce, parseSessionMessage, type SessionRequest, sessionMessage } from "./message";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const request: SessionRequest = {
  wallet: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  nonce: "0123456789abcdef0123456789abcdef",
  expiresAt: NOW + MESSAGE_TTL_MS,
};

test("a built message parses back to the same request", () => {
  assert.deepEqual(parseSessionMessage(sessionMessage(request), NOW), { ok: true, request });
});

test("the message reads plainly in a wallet popup", () => {
  assert.equal(
    sessionMessage(request),
    [
      "memestream predictions: free points, no money, no prizes",
      "Sign in to play predictions. This costs nothing and sends nothing.",
      `Wallet: ${request.wallet}`,
      `Nonce: ${request.nonce}`,
      "Expires: 2026-10-09T12:05:00.000Z",
    ].join("\n"),
  );
});

test("expiry: refused at and after the expiry, accepted just before", () => {
  const text = sessionMessage(request);
  assert.equal(parseSessionMessage(text, request.expiresAt - 1).ok, true);
  assert.equal(parseSessionMessage(text, request.expiresAt).ok, false);
  assert.equal(parseSessionMessage(text, request.expiresAt + 1).ok, false);
});

test("expiry: refused when set too far ahead", () => {
  const far = sessionMessage({ ...request, expiresAt: NOW + 60 * 60 * 1000 });
  assert.deepEqual(parseSessionMessage(far, NOW), { ok: false, error: "Expiry too far ahead. Check your clock." });
});

test("malformed or tampered messages are refused", () => {
  const text = sessionMessage(request);
  const cases = [
    text.replace(request.wallet, "not-a-wallet"),
    text.replace(request.nonce, "short"),
    text.replace(/Expires: .*/, "Expires: tomorrow"),
    text.replace("memestream predictions", "other app"),
    text.replace("costs nothing", "costs 1 SOL"),
    `${text}\nExtra: line`,
    text.split("\n").slice(0, -1).join("\n"),
    text.replace("Wallet: ", "Wallet:"),
    text.replace("Nonce: ", "Nonce: \n"),
  ];
  for (const bad of cases) assert.equal(parseSessionMessage(bad, NOW).ok, false, bad);
});

test("nonces are 32 hex characters and differ", () => {
  const a = newNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newNonce());
});
