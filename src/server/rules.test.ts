import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { UserError } from "./errors";
import { assertNotSelfBuy, SELF_BUY_MESSAGE } from "./rules";

test("a streamer's wallet can't buy its own coin, but can sell, and others can buy", () => {
  const creator = Keypair.generate().publicKey;
  const viewer = Keypair.generate().publicKey;
  assert.throws(() => assertNotSelfBuy("buy", creator, creator), (e) => e instanceof UserError && e.message === SELF_BUY_MESSAGE);
  assert.doesNotThrow(() => assertNotSelfBuy("sell", creator, creator));
  assert.doesNotThrow(() => assertNotSelfBuy("buy", creator, viewer));
});
