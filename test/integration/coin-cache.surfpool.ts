// Audit N1: concurrent requests for one coin share a single read, so one client can't drain the
// site-wide RPC budget with a burst. Uses a fake JSON-RPC server (no chain needed); runs with the
// react-server condition like the other server tests.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Keypair } from "@solana/web3.js";

let rpcCalls = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    rpcCalls++;
    const message = JSON.parse(body);
    // Every account "exists" but holds no pool data, so a read costs calls and then finds no coin.
    const reply = (m: { id: number; method: string }) => ({
      jsonrpc: "2.0",
      id: m.id,
      result: { context: { slot: 1 }, value: m.method === "getAccountInfo" ? { data: ["AAAA", "base64"], executable: false, lamports: 1, owner: "11111111111111111111111111111111", rentEpoch: 0 } : null },
    });
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(message) ? message.map(reply) : reply(message)));
    }, 200);
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.MEMESTREAM_RPC_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.MEMESTREAM_CONFIG = Keypair.generate().publicKey.toBase58();
  process.env.MEMESTREAM_PUBLIC_URL = "http://127.0.0.1:3999";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_REST_API_URL;
});
after(() => server.close());

test("20 concurrent requests for one coin share one read: none is refused as busy", async () => {
  const { getCoinDetail } = await import("../../src/server/coins");
  const mint = Keypair.generate().publicKey.toBase58();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => getCoinDetail(mint, null)));
    // The fake pool data doesn't decode, so reads end in an error; what matters is that none was refused for budget.
    const busy = results.filter((r) => r.status === "rejected" && (r.reason as Error).name === "BusyError").length;
    assert.equal(busy, 0, "no request refused as busy");
    assert.ok(rpcCalls <= 5, `one shared read, not twenty (made ${rpcCalls} RPC calls)`);
  } finally {
    console.warn = warn;
  }
});
