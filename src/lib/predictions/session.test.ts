import assert from "node:assert/strict";
import { test } from "node:test";
import { serverDroppedSession, SESSION_EXPIRY_MARGIN_MS, sessionDropAt, sessionUsable } from "./session";

const T0 = 1_000_000;
const SESSION = { wallet: "walletA", token: "tok-1", expiresAt: T0 + 6 * 3_600_000 };

test("a saved session counts only for its wallet, until the margin before it expires; it drops itself then", () => {
  assert.equal(sessionUsable(SESSION, "walletA", T0), true);
  assert.equal(sessionUsable(SESSION, "walletB", T0), false);
  assert.equal(sessionUsable(SESSION, null, T0), false);
  assert.equal(sessionUsable(null, "walletA", T0), false);
  assert.equal(sessionDropAt(SESSION), SESSION.expiresAt - SESSION_EXPIRY_MARGIN_MS);
  assert.equal(sessionUsable(SESSION, "walletA", sessionDropAt(SESSION) - 1), true);
  assert.equal(sessionUsable(SESSION, "walletA", sessionDropAt(SESSION)), false, "at the drop time: sign in again");
});

test("the server's me: null drops the session that request carried, never a newer one or an anonymous request's", () => {
  assert.equal(serverDroppedSession("tok-1", "tok-1", null), true);
  assert.equal(serverDroppedSession("tok-1", "tok-1", { role: null }), false, "the server knows it");
  assert.equal(serverDroppedSession(null, "tok-1", null), false, "a request sent before sign-in");
  assert.equal(serverDroppedSession("tok-1", "tok-2", null), false, "signed in again meanwhile");
});
