import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGE_TTL_MS, newNonce, parseStakeMessage, type StakeRequest, stakeMessage } from "./message";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const request: StakeRequest = {
  mint: "So11111111111111111111111111111111111111112",
  side: "yes",
  points: 250,
  wallet: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  nonce: "0123456789abcdef0123456789abcdef",
  expiresAt: NOW + MESSAGE_TTL_MS,
};

test("a built message parses back to the same request", () => {
  assert.deepEqual(parseStakeMessage(stakeMessage(request), NOW), { ok: true, request });
});

test("expiry: refused at and after the expiry, accepted just before", () => {
  const text = stakeMessage(request);
  assert.equal(parseStakeMessage(text, request.expiresAt - 1).ok, true);
  assert.equal(parseStakeMessage(text, request.expiresAt).ok, false);
  assert.equal(parseStakeMessage(text, request.expiresAt + 1).ok, false);
});

test("expiry: refused when set too far ahead", () => {
  const far = stakeMessage({ ...request, expiresAt: NOW + 60 * 60 * 1000 });
  assert.deepEqual(parseStakeMessage(far, NOW), { ok: false, error: "Expiry too far ahead. Check your clock." });
});

test("malformed or tampered messages are refused", () => {
  const text = stakeMessage(request);
  const cases = [
    text.replace("Side: yes", "Side: maybe"),
    text.replace("Points: 250", "Points: 0"),
    text.replace("Points: 250", "Points: -5"),
    text.replace("Points: 250", "Points: 2.5"),
    text.replace("Points: 250", "Points: 0250"),
    text.replace("Action: stake", "Action: withdraw"),
    text.replace(request.wallet, "not-a-wallet"),
    text.replace(request.nonce, "short"),
    text.replace(/Expires: .*/, "Expires: tomorrow"),
    text.replace("memestream predictions", "other app"),
    `${text}\nExtra: line`,
    text.split("\n").slice(0, -1).join("\n"),
    text.replace("Coin: ", "Coin:"),
  ];
  for (const bad of cases) assert.equal(parseStakeMessage(bad, NOW).ok, false, bad);
});

test("nonces are 32 hex characters and differ", () => {
  const a = newNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newNonce());
});
