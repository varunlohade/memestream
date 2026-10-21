import assert from "node:assert/strict";
import { test } from "node:test";
import { isBusy, walletFailure, WalletNotConnected, walletSaid } from "./tx-flow";

test("busy means rate limited (429) or out of RPC budget (503), not any server error", () => {
  assert.equal(isBusy({ status: 429 }), true);
  assert.equal(isBusy({ status: 503 }), true);
  assert.equal(isBusy({ status: 500 }), false);
  assert.equal(isBusy(null), false);
});

test("walletFailure: the hold is dropped only on code 4001, code 4100, or our own error before the wallet was asked; message text never counts", () => {
  assert.equal(walletFailure({ code: 4001, message: "User rejected the request." }), "rejected");
  assert.equal(walletFailure({ code: 4100, message: "The requested method and/or account has not been authorized" }), "not-sent");
  assert.equal(walletFailure(new WalletNotConnected()), "not-sent");
  for (const maybeSent of [
    new Error("Transaction simulation failed: This transaction has already been processed"),
    new Error("User rejected"),
    new Error("Request cancelled"),
    new Error("Connect a wallet first"),
    new Error("Insufficient funds for fee"),
    { code: 4900, message: "Disconnected" },
    { code: -32603, message: "Internal JSON-RPC error." },
    null,
    "boom",
  ])
    assert.equal(walletFailure(maybeSent), "maybe-sent", String((maybeSent as Error | null)?.message ?? maybeSent));
});

test("walletSaid: the wallet's own message, plainly prefixed and cut to 140 characters", () => {
  assert.equal(walletSaid(new Error("  Blockhash\n not found ")), "Your wallet said: Blockhash not found");
  const long = walletSaid(new Error("x".repeat(500)))!;
  assert.equal(long.length, "Your wallet said: ".length + 140);
  assert.ok(long.endsWith("…"));
  assert.equal(walletSaid(new Error("")), null);
  assert.equal(walletSaid(null), null);
});
