// Coin detail around graduation, against a fake JSON-RPC server: a known coin (its DBC pool exists)
// never reads as "not found" because of a failed or empty read; made-up addresses still do, cached.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, mock, test } from "node:test";
import { deriveDbcPoolAddress, DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { QUOTE } from "@/lib/dbc/units";

/** What a getAccountInfo of a DBC pool answers next: its data, "absent" (a lagging node), or "fail" (429). */
type Read = "ok" | "absent" | "fail";
const accounts = new Map<string, Buffer>();
const scripted = new Map<string, Read[]>();
let rpcCalls = 0;

type RpcRequest = { id: number; method: string; params: unknown[] };
const asInfo = (data: Buffer | undefined) =>
  data ? { data: [data.toString("base64"), "base64"], executable: false, lamports: 1, owner: "11111111111111111111111111111111", rentEpoch: 0 } : null;

function reply({ id, method, params }: RpcRequest) {
  const context = { slot: 1 };
  if (method === "getAccountInfo") {
    const key = params[0] as string;
    const next = scripted.get(key)?.shift() ?? "ok";
    if (next === "fail") return { jsonrpc: "2.0", id, error: { code: -32429, message: "Too many requests" } };
    return { jsonrpc: "2.0", id, result: { context, value: next === "absent" ? null : asInfo(accounts.get(key)) } };
  }
  // The graduated Meteora pool and the token metadata aren't visible: every batched account is missing.
  if (method === "getMultipleAccounts") return { jsonrpc: "2.0", id, result: { context, value: (params[0] as string[]).map(() => null) } };
  return { jsonrpc: "2.0", id, result: [] }; // no trade history
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    rpcCalls++;
    const message = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(message) ? message.map(reply) : reply(message)));
  });
});

const config = Keypair.generate().publicKey;
/** Encodes a DBC account with the program's own layout: all zeros except what `fill` sets. */
const coder = (new DynamicBondingCurveClient(new Connection("http://127.0.0.1:1"), "confirmed").state as unknown as {
  program: { coder: { accounts: { size(n: string): number; decodeUnchecked(n: string, d: Buffer): Record<string, unknown>; accountLayouts: Map<string, { discriminator: number[]; layout: { encode(v: unknown, b: Buffer, o: number): number } }> } } };
}).program.coder.accounts;
function encode(name: string, fill: (zeros: Record<string, unknown>) => void): Buffer {
  const size = coder.size(name);
  const { discriminator, layout } = coder.accountLayouts.get(name)!;
  const account = coder.decodeUnchecked(name, Buffer.alloc(size));
  fill(account);
  const data = Buffer.alloc(size);
  Buffer.from(discriminator).copy(data);
  layout.encode(account, data, discriminator.length);
  return data;
}

/** A memestream coin on our config: its pool account, full (graduating) or migrated (graduated). */
function setPool(mint: PublicKey, migrated: boolean): string {
  const pool = deriveDbcPoolAddress(QUOTE.mint, mint, config).toBase58();
  const state = { config, baseMint: mint, creator: Keypair.generate().publicKey, quoteReserve: new BN(1), isMigrated: migrated ? 1 : 0 };
  accounts.set(pool, encode("virtualPool", (zeros) => Object.assign(zeros.poolState as object, state)));
  return pool;
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.MEMESTREAM_RPC_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.MEMESTREAM_CONFIG = config.toBase58();
  process.env.MEMESTREAM_PUBLIC_URL = "http://127.0.0.1:3999";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_REST_API_URL;
  accounts.set(config.toBase58(), encode("poolConfig", (zeros) => Object.assign(zeros, { migrationQuoteThreshold: new BN(1) })));
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  console.warn = () => {};
});
after(() => server.close());

const DETAIL_CACHE_MS = 4_000;
const MISS_CACHE_MS = 30_000;

test("right after graduation a failed read serves the last good coin, not 'not found'", async () => {
  const { getCoinDetail } = await import("./coins");
  const mint = Keypair.generate().publicKey;
  const pool = setPool(mint, false);
  assert.equal((await getCoinDetail(mint.toBase58(), null))?.coin.status, "graduating");

  // Migration lands: the DBC pool is migrated, the Meteora pool isn't visible yet, and the RPC
  // refuses one read (the SDK swallows it and decodes the pool as the wrong account type).
  setPool(mint, true);
  scripted.set(pool, ["fail"]);
  mock.timers.tick(DETAIL_CACHE_MS + 1);
  assert.equal((await getCoinDetail(mint.toBase58(), null))?.coin.status, "graduating", "last good data");

  // An empty read (a lagging RPC node) is not a miss either.
  scripted.set(pool, ["absent", "absent"]);
  mock.timers.tick(DETAIL_CACHE_MS + 1);
  assert.equal((await getCoinDetail(mint.toBase58(), null))?.coin.status, "graduating", "last good data");

  // Once reads work, the graduated coin shows, with its Meteora pool address and no 30 s wait.
  mock.timers.tick(DETAIL_CACHE_MS + 1);
  const detail = await getCoinDetail(mint.toBase58(), null);
  assert.equal(detail?.coin.status, "graduated");
  assert.ok(detail.coin.meteoraPool);
});

test("a coin seen for the first time mid-graduation: a failed read throws (busy), is never cached as unknown", async () => {
  const { getCoinDetail } = await import("./coins");
  const mint = Keypair.generate().publicKey;
  const pool = setPool(mint, true);
  // The existence check sees the pool; the full read then comes back empty (a lagging node).
  scripted.set(pool, ["ok", "absent", "absent"]);
  await assert.rejects(getCoinDetail(mint.toBase58(), null));
  // At once (no 30 s miss window), the next request reads it.
  assert.equal((await getCoinDetail(mint.toBase58(), null))?.coin.status, "graduated");
});

test("a made-up address is not found, and remembered for 30 s so it can't force reads", async () => {
  const { getCoinDetail } = await import("./coins");
  const mint = Keypair.generate().publicKey.toBase58();
  assert.equal(await getCoinDetail(mint, null), null);
  const calls = rpcCalls;
  assert.equal(await getCoinDetail(mint, null), null);
  assert.equal(rpcCalls, calls, "the miss is cached: no RPC call");
  mock.timers.tick(MISS_CACHE_MS + 1);
  assert.equal(await getCoinDetail(mint, null), null);
  assert.equal(rpcCalls, calls + 1, "after 30 s one existence check, then a miss again");
});
