import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeDeployment, deploymentProblems, isMainnet } from "./network";

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
  assert.deepEqual(deploymentProblems({ MEMESTREAM_RPC_URL: "https://devnet.helius-rpc.com/?api-key=x" }), []);
});

test("on mainnet the public URL must be an https origin", () => {
  assert.equal(deploymentProblems({ ...mainnet, MEMESTREAM_PUBLIC_URL: "http://localhost:3000" }).length, 1);
  assert.equal(deploymentProblems({ ...mainnet, MEMESTREAM_PUBLIC_URL: "https://www.memestream.lol/coin" }).length, 1);
});
