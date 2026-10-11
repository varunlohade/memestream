import { test } from "node:test";
import assert from "node:assert/strict";
import { solscanAccount, solscanTx } from "./explorer";

test("Solscan links name the cluster except on mainnet", () => {
  assert.equal(solscanTx("sig1", "solana:devnet"), "https://solscan.io/tx/sig1?cluster=devnet");
  assert.equal(solscanTx("sig1", "solana:mainnet"), "https://solscan.io/tx/sig1");
  assert.equal(solscanAccount("Addr", "solana:devnet"), "https://solscan.io/account/Addr?cluster=devnet");
});
