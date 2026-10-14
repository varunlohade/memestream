import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { networkInfo } from "./chain";
import { marketsEnabled } from "./predictions/flag";

const KEYS = ["MEMESTREAM_WALLET_CHAIN", "MEMESTREAM_NETWORK_LABEL", "MEMESTREAM_PREDICTIONS", "MEMESTREAM_MARKETS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("real-SOL markets are off on mainnet even with MEMESTREAM_MARKETS=1", () => {
  process.env.MEMESTREAM_PREDICTIONS = "1";
  process.env.MEMESTREAM_MARKETS = "1";
  process.env.MEMESTREAM_WALLET_CHAIN = "solana:devnet";
  assert.equal(marketsEnabled(), true, "devnet: on");
  process.env.MEMESTREAM_WALLET_CHAIN = "solana:mainnet";
  assert.equal(marketsEnabled(), false, "mainnet: forced off");
});

test("mainnet is always labelled Mainnet", () => {
  process.env.MEMESTREAM_WALLET_CHAIN = "solana:mainnet";
  process.env.MEMESTREAM_NETWORK_LABEL = "Devnet";
  assert.deepEqual(networkInfo(), { label: "Mainnet", walletChain: "solana:mainnet" });
  delete process.env.MEMESTREAM_WALLET_CHAIN;
  delete process.env.MEMESTREAM_NETWORK_LABEL;
  assert.deepEqual(networkInfo(), { label: "Devnet", walletChain: "solana:devnet" });
});
