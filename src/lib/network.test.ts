import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeDeployment, clusterMismatch, deploymentProblems, isMainnet, MAINNET_GENESIS_HASH } from "./network";

const mainnet = { MEMESTREAM_WALLET_CHAIN: "solana:mainnet", MEMESTREAM_PUBLIC_URL: "https://www.memestream.lol", MEMESTREAM_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" };

test("only solana:mainnet counts as mainnet", () => {
  assert.equal(isMainnet(mainnet), true);
  assert.equal(isMainnet({ MEMESTREAM_WALLET_CHAIN: "solana:devnet" }), false);
  assert.equal(isMainnet({}), false);
});

test("a clean mainnet env passes", () => {
  assert.deepEqual(deploymentProblems(mainnet), []);
  assert.doesNotThrow(() => assertSafeDeployment(mainnet));
});

test("the test wallet key on mainnet stops the build and the server", () => {
  const env = { ...mainnet, MEMESTREAM_DEV_WALLET_KEY: "/tmp/key.json" };
  assert.throws(() => assertSafeDeployment(env), /MEMESTREAM_DEV_WALLET_KEY/);
});

test("the test wallet key is fine off mainnet (local dev chain)", () => {
  assert.deepEqual(deploymentProblems({ MEMESTREAM_DEV_WALLET_KEY: "/tmp/k.json", MEMESTREAM_RPC_URL: "http://127.0.0.1:8899" }), []);
});

test("a mainnet RPC without the mainnet wallet chain is refused", () => {
  assert.match(deploymentProblems({ MEMESTREAM_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" })[0], /points at mainnet/);
  assert.match(deploymentProblems({ MEMESTREAM_RPC_URL: "https://api.mainnet-beta.solana.com" })[0], /points at mainnet/);
  assert.match(deploymentProblems({ MEMESTREAM_RPC_URL: "https://solana-mainnet.g.alchemy.com/v2/x" })[0], /points at mainnet/);
  assert.match(deploymentProblems({ MEMESTREAM_RPC_URL: "https://abc.solana-mainnet.quiknode.pro/x/" })[0], /points at mainnet/);
  assert.deepEqual(deploymentProblems({ MEMESTREAM_RPC_URL: "https://devnet.helius-rpc.com/?api-key=x" }), []);
});

test("the RPC's genesis hash must match the wallet chain, whatever its hostname", () => {
  const devnetGenesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  assert.equal(clusterMismatch(MAINNET_GENESIS_HASH, mainnet), null);
  assert.equal(clusterMismatch(devnetGenesis, {}), null);
  assert.match(clusterMismatch(MAINNET_GENESIS_HASH, {}) ?? "", /is a mainnet RPC/);
  assert.match(clusterMismatch(devnetGenesis, mainnet) ?? "", /not a mainnet RPC/);
});

test("on mainnet the public URL must be an https origin", () => {
  assert.equal(deploymentProblems({ ...mainnet, MEMESTREAM_PUBLIC_URL: "http://localhost:3000" }).length, 1);
  assert.equal(deploymentProblems({ ...mainnet, MEMESTREAM_PUBLIC_URL: "https://www.memestream.lol/coin" }).length, 1);
});
