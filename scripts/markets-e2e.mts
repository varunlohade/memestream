/**
 * DEVNET ONLY: one full prediction-market round against a running memestream server (next start
 * with MEMESTREAM_PREDICTIONS=1 and MEMESTREAM_MARKETS=1), through its real HTTP routes:
 * the streamer launches a question -> the server opens its market -> a viewer buys YES (devnet SOL)
 * and sells half back -> the lock closes trading -> the streamer proposes YES -> the challenge window
 * ends -> the server resolves the market -> the viewer redeems. Then the oracle redeems its seed.
 * Run the server with MEMESTREAM_MARKET_CHALLENGE_MIN=3 (test runs only) so the window is short.
 *
 * Run:  BASE_URL=http://127.0.0.1:3000 MEMESTREAM_PREDICTIONS_PREFIX=memestream:pm-e2e:<run>: \
 *       KV_REST_API_URL=... KV_REST_API_TOKEN=... npx tsx --conditions=react-server scripts/markets-e2e.mts
 * Optional: MARKET_E2E_MINT=<a devnet memestream coin by .keys/devnet-creator.json> (else one is
 * launched), SHOT_CMD (run as `SHOT_CMD <state>
 * <mint> <wallet>` at each card state: open, position, closed, proposed, resolved).
 *
 * Wallets: streamer .keys/devnet-creator.json, viewer .keys/e2e-viewer-1.json, oracle
 * .keys/partner.json (also tops the others up). Prints every devnet signature; never a key.
 * Deletes only the Redis keys under the test prefix at the end.
 */
import { execSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { Redis } from "@upstash/redis";
import bs58 from "bs58";
import { marketKeysFromId } from "../src/lib/markets/pool";
import type { MarketRecord, MarketView } from "../src/lib/markets/record";
import { buildRedeemTx } from "../src/lib/markets/settle";
import { MESSAGE_TTL_MS, newNonce, sessionMessage } from "../src/lib/predictions/message";
import { GRANT_POINTS } from "../src/lib/predictions/rules";
import type { PredictionsView } from "../src/lib/predictions/view";
import { sleep } from "../src/lib/poll";
import { redisStore } from "../src/server/predictions/store";
import { connectToDevnet } from "./devnet";
import { readKeypair } from "./keys";

const BASE_URL = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const PREFIX = process.env.MEMESTREAM_PREDICTIONS_PREFIX ?? "";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const BET_SOL = "0.005";
const API_GAP_MS = 1_100;

if (!BASE_URL) throw new Error("Set BASE_URL, e.g. http://127.0.0.1:3000");
if (!/^memestream:pm-e2e:[\w-]+:$/.test(PREFIX)) throw new Error("Set MEMESTREAM_PREDICTIONS_PREFIX=memestream:pm-e2e:<run id>: (the same one the server uses)");
if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Set the server's Upstash URL and token, to read the market registry and clean up");

const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN, automaticDeserialization: false }); // the store reads raw JSON text
const connection = await connectToDevnet(); // refuses anything but devnet
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s`;
const log = (text: string) => console.log(`${elapsed()}  ${text}`);
let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${elapsed()}  ${name}  (${detail})`);
}

type Reply = { status: number; json: Record<string, unknown> };
let queue: Promise<unknown> = Promise.resolve();
/** HTTP calls are spaced out under each route's per-client limit. */
async function http(method: "GET" | "POST", path: string, opts: { token?: string; body?: unknown } = {}): Promise<Reply> {
  const turn = queue.then(() => sleep(API_GAP_MS));
  queue = turn;
  await turn;
  const headers: Record<string, string> = { origin: BASE_URL };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
async function ok<T>(method: "GET" | "POST", path: string, opts: Parameters<typeof http>[2] = {}): Promise<T> {
  const r = await http(method, path, opts);
  if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${String(r.json.error ?? "")}`);
  return r.json as T;
}

/** Ask the server to build, sign locally, send to devnet, and wait on the server's own status route. */
async function sendViaApp(action: string, wallet: Keypair, body: Record<string, unknown>) {
  const prepared = await ok<{ transaction: string; blockhash: string; mint?: string }>("POST", `/api/tx/${action}`, { body: { wallet: wallet.publicKey.toBase58(), ...body } });
  const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  tx.partialSign(wallet);
  const sig = await connection.sendRawTransaction(tx.serialize());
  for (let i = 0; i < 60; i++) {
    await sleep(2_000);
    const s = await ok<{ status: string; error?: string }>("GET", `/api/tx/status?signature=${sig}&blockhash=${prepared.blockhash}`);
    if (s.status === "confirmed") return { ...prepared, sig };
    if (s.status !== "pending") throw new Error(`${action}: ${s.status} ${s.error ?? ""} ${sig}`);
  }
  throw new Error(`${action}: no answer in 2 min (${sig})`);
}

function signIn(keypair: Keypair) {
  const domain = new URL(BASE_URL).host;
  const message = sessionMessage({ domain, wallet: keypair.publicKey.toBase58(), nonce: newNonce(), expiresAt: Date.now() + MESSAGE_TTL_MS - 30_000 });
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(keypair.secretKey.slice(0, 32)).toString("base64url"), x: Buffer.from(keypair.publicKey.toBytes()).toString("base64url") },
    format: "jwk",
  });
  return { message, signature: bs58.encode(sign(null, Buffer.from(message), key)) };
}

async function topUp(from: Keypair, wallets: { keypair: Keypair; min: number; target: number }[]) {
  const tx = new Transaction();
  for (const w of wallets) {
    const have = await connection.getBalance(w.keypair.publicKey);
    if (have < w.min * LAMPORTS_PER_SOL) tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: w.keypair.publicKey, lamports: Math.round(w.target * LAMPORTS_PER_SOL) - have }));
  }
  if (tx.instructions.length === 0) return "all funded already";
  return `top-ups ${await connection.sendTransaction(tx, [from])}`;
}

type SessionReply = { wallet: string; token: string; expiresAt: number; granted: number };

/** Screenshots of the card as `wallet` sees it; with `session`, signed in to predictions too (the page reads it from localStorage). */
function shot(state: string, mint: string, wallet: string, session?: SessionReply) {
  if (!process.env.SHOT_CMD) return;
  log(`screenshots: ${state}`);
  execSync(`${process.env.SHOT_CMD} ${state} ${mint} ${wallet}`, { stdio: "inherit", env: { ...process.env, SHOT_SESSION: session ? JSON.stringify(session) : "" } });
}

async function cleanup() {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: `${PREFIX}*`, count: 500 });
    cursor = String(next);
    keys.push(...batch.filter((k) => k.startsWith(PREFIX)));
  } while (cursor !== "0");
  for (let i = 0; i < keys.length; i += 100) await redis.del(...keys.slice(i, i + 100));
  log(`cleanup: deleted ${keys.length} keys under ${PREFIX}`);
}

async function run() {
  const oracle = readKeypair(".keys/partner.json");
  const creator = readKeypair(".keys/devnet-creator.json");
  const viewer = readKeypair(".keys/e2e-viewer-1.json");
  // A memestream admin locally (MEMESTREAM_ADMIN_WALLETS): settles the challenge.
  const adminKey = readKeypair(".keys/e2e-viewer-2.json");
  const oracleStart = await connection.getBalance(oracle.publicKey);
  log(`fund: ${await topUp(oracle, [{ keypair: creator, min: 0.06, target: 0.1 }, { keypair: viewer, min: 0.03, target: 0.05 }])}`);

  let mint = process.env.MARKET_E2E_MINT ?? "";
  if (!mint) {
    const symbol = `MK${Date.now().toString(36).slice(-6).toUpperCase()}`;
    const launched = await sendViaApp("launch", creator, { name: "markets e2e", symbol, streamUrl: "https://www.youtube.com/watch?v=4xDzrJKXOOY" });
    mint = launched.mint!;
    log(`launch: $${symbol} ${mint}  ${launched.sig}`);
  }
  const coinPath = `/api/predictions/coin/${mint}`;

  const session = await ok<SessionReply>("POST", "/api/predictions/session", { body: signIn(creator) });
  await http("POST", "/api/predictions/heartbeat", { token: session.token, body: { mint } });
  // The viewer's first sign-in grants points at once: enough for a challenge bond.
  const viewerSession = await ok<SessionReply>("POST", "/api/predictions/session", { body: signIn(viewer) });
  const adminSession = await ok<SessionReply>("POST", "/api/predictions/session", { body: signIn(adminKey) });
  check("points: the viewer's first sign-in grants points at once", viewerSession.granted === GRANT_POINTS, `+${viewerSession.granted} points`);
  const view = () => ok<PredictionsView>("GET", coinPath, { token: session.token });
  // The AI review picks the betting window from the text: this one asks for about 5 minutes.
  const text = `Will chat say gg in the next 5 minutes? (${Date.now().toString(36).slice(-4)})`;
  const SOURCE = "https://liquipedia.net/counterstrike/Main_Page";
  await ok("POST", coinPath, { token: session.token, body: { kind: "launch", text, source: SOURCE } });
  log(`launch: "${text}"`);

  /** Polls the streamer's view (each poll also runs the server's due market steps) until `done`. */
  async function waitFor<T>(what: string, done: (v: PredictionsView) => T | undefined, ms: number): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const found = done(await view());
      if (found !== undefined) return found;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await sleep(3_000);
    }
  }
  const opened = await waitFor("the market to open", (v) => v.live.find((l) => l.text === text && (l.market === "open" || l.market === "failed")), 4 * 60_000);
  check("market: the server opened it after the review", opened.market === "open", `market ${opened.market}, window ${Math.round((opened.lockAt - opened.launchedAt) / 60_000)} min`);
  if (opened.market !== "open") throw new Error("market failed to open");
  const id = opened.id;
  const record = JSON.parse((await redisStore(redis, PREFIX).read([`market:${mint}:${id}`]))[0].json ?? "null") as MarketRecord | null;
  check("market: registered with its addresses, lockAt and source", record?.lockAt === opened.lockAt && Boolean(record?.question) && record?.source === SOURCE, `question ${record?.question}, create ${record?.signature}, source ${record?.source}`);
  if (!record) throw new Error("no registry entry");

  const odds = (wallet: Keypair | null) => ok<MarketView>("POST", "/api/markets/odds", { body: { mint, predictionId: id, wallet: wallet?.publicKey.toBase58() } });
  const before = await odds(viewer);
  check("odds: a fresh market is 50/50 and taking bets", before.trading && Math.abs(before.probability.yes - 0.5) < 1e-6, `yes ${before.probability.yes}`);
  shot("open", mint, viewer.publicKey.toBase58(), viewerSession);

  const streamerBet = await http("POST", "/api/tx/market", { body: { wallet: creator.publicKey.toBase58(), mint, predictionId: id, side: "no", action: "buy", amount: BET_SOL } });
  check("bet: the streamer can't bet on their own market", streamerBet.status === 400, `${streamerBet.status} "${String(streamerBet.json.error)}"`);
  const big = await http("POST", "/api/markets/preview", { body: { mint, predictionId: id, side: "yes", action: "buy", amount: "0.1" } });
  check(
    "bet: a bet twice the seed fills (only the price moves)",
    big.status === 200 && Number(big.json.received) > 0.1 && Number(big.json.probabilityAfter) > 0.6,
    `${big.status} gets ${String(big.json.received)} YES, YES ${Number(big.json.probabilityAfter).toFixed(3)} after, impact ${(Number(big.json.priceImpact) * 100).toFixed(1)}%`,
  );
  const preview = await ok<{ received: string; minimumReceived: string }>("POST", "/api/markets/preview", { body: { mint, predictionId: id, side: "yes", action: "buy", amount: BET_SOL } });
  const bought = await sendViaApp("market", viewer, { mint, predictionId: id, side: "yes", action: "buy", amount: BET_SOL, minReceived: preview.minimumReceived });
  log(`bet: viewer bought YES for ${BET_SOL} SOL  ${bought.sig}`);
  const after = await odds(viewer);
  check("bet: the odds moved to YES and the viewer holds YES", after.probability.yes > 0.5 && Number(after.position?.yes) >= Number(preview.minimumReceived), `yes ${after.probability.yes.toFixed(3)}, holds ${after.position?.yes} YES, vol ${after.volumeSol}`);
  const half = (Number(after.position?.yes ?? 0) / 2).toFixed(9);
  const sellPreview = await ok<{ received: string }>("POST", "/api/markets/preview", { body: { mint, predictionId: id, side: "yes", action: "sell", amount: half } });
  const solBeforeSell = await connection.getBalance(viewer.publicKey);
  const sold = await sendViaApp("market", viewer, { mint, predictionId: id, side: "yes", action: "sell", amount: half, minReceived: sellPreview.received });
  const soldFor = (await connection.getBalance(viewer.publicKey)) - solBeforeSell;
  log(`sell: viewer sold ${half} YES for ${sellPreview.received} SOL  ${sold.sig}`);
  check("sell: half the YES sold back for SOL", soldFor > 0, `+${soldFor / LAMPORTS_PER_SOL} SOL after network fees`);
  shot("position", mint, viewer.publicKey.toBase58(), viewerSession);

  const wait = record.lockAt - Date.now() + 2_000;
  log(`waiting ${Math.ceil(wait / 1000)} s for the lock`);
  await sleep(Math.max(0, wait));
  const late = await http("POST", "/api/tx/market", { body: { wallet: viewer.publicKey.toBase58(), mint, predictionId: id, side: "yes", action: "buy", amount: BET_SOL } });
  check("lock: bets are refused once betting closes", late.status === 400 && /closed/.test(String(late.json.error)), `${late.status} "${String(late.json.error)}"`);
  await waitFor("trading to close on chain", (v) => (v.live.find((l) => l.id === id)?.market === "closed" ? true : undefined), 4 * 60_000);
  check("lock: the server closed trading", true, "market closed");
  shot("closed", mint, viewer.publicKey.toBase58(), viewerSession);

  // The memestream oracle (an admin) resolves; the streamer can only say what happened.
  await ok("POST", coinPath, { token: session.token, body: { kind: "witness", id, outcome: "yes", note: "gg typed in chat" } });
  await ok("POST", coinPath, { token: adminSession.token, body: { kind: "resolve", id, outcome: "yes" } });
  log("resolve: the streamer proposed YES; the challenge window runs");
  const proposed = await waitFor("the proposal", (v) => v.resolved.find((x) => x.id === id && x.verdict?.status === "proposed"), 60_000);
  check("challenge window: the result is proposed, final at the window's end", proposed.verdict?.finalAt !== null, `final at ${new Date(proposed.verdict!.finalAt!).toISOString()}`);
  shot("proposed", mint, viewer.publicKey.toBase58(), viewerSession);

  // The viewer (a holder) challenges with the points bond; an admin settles it.
  const challenge = await http("POST", coinPath, { token: viewerSession.token, body: { kind: "challenge", id, reason: "The streamer typed gg first, not chat", link: "https://clips.example/gg" } });
  const disputed = (challenge.json.resolved as PredictionsView["resolved"] | undefined)?.find((x) => x.id === id);
  check("challenge: a holder challenges, posting the 100-point bond", challenge.status === 200 && disputed?.verdict?.status === "disputed", `${challenge.status} ${String(challenge.json.error ?? disputed?.verdict?.status)}`);
  const asAdmin = await ok<PredictionsView>("GET", coinPath, { token: adminSession.token });
  const adminSees = asAdmin.resolved.find((x) => x.id === id)?.verdict;
  check("challenge: the admin sees the reason and the evidence", asAdmin.me?.admin === true && adminSees?.challenge?.reason === "The streamer typed gg first, not chat", `admin ${asAdmin.me?.admin}, why ${adminSees?.why}`);
  shot("disputed", mint, adminKey.publicKey.toBase58(), adminSession);
  await ok("POST", coinPath, { token: adminSession.token, body: { kind: "decide", id, outcome: "yes" } });
  log("decide: the admin upheld YES");
  const result = await waitFor("the market to resolve", (v) => {
    const r = v.resolved.find((x) => x.id === id);
    return r?.market === "resolved" ? r : undefined;
  }, 10 * 60_000);
  check("resolve: the server resolved the market as the admin decided", result.verdict?.final === "yes", `final ${result.verdict?.final}`);
  const settled = await odds(viewer);
  check("resolve: YES pays [1,0]", JSON.stringify(settled.payoutNumerators) === "[1,0]", JSON.stringify(settled.payoutNumerators));
  shot("resolved", mint, viewer.publicKey.toBase58(), viewerSession);

  const solBefore = await connection.getBalance(viewer.publicKey);
  const redeemed = await sendViaApp("market-redeem", viewer, { mint, predictionId: id });
  const gained = (await connection.getBalance(viewer.publicKey)) - solBefore;
  log(`redeem: viewer  ${redeemed.sig}`);
  check("redeem: the viewer's YES paid out", gained > 0, `+${gained / LAMPORTS_PER_SOL} SOL`);

  // The server redeems the oracle's seed by itself once the market is closed and resolved.
  const keys = marketKeysFromId(connection, Uint8Array.from(Buffer.from(record.questionId, "hex")), oracle.publicKey);
  const leftover = await buildRedeemTx(connection, keys, oracle.publicKey).then(
    () => true,
    (error: Error) => (/holds no YES or NO/.test(error.message) ? false : Promise.reject(error)),
  );
  check("redeem: the server already redeemed the oracle's seed", !leftover, leftover ? "the oracle still holds shares" : "nothing left to redeem");
  log(`oracle spent ${((oracleStart - (await connection.getBalance(oracle.publicKey))) / LAMPORTS_PER_SOL).toFixed(6)} SOL this run (incl. top-ups)`);
}

try {
  await run();
} catch (error) {
  failures += 1;
  console.log(`FAIL ${elapsed()}  ${(error as Error).message}`);
} finally {
  await cleanup();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
