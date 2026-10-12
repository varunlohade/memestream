/**
 * DEVNET ONLY: one full predictions game (free points, no money) against a running memestream
 * server, through its real HTTP routes, with real devnet coins and the server's real Upstash Redis.
 * The server must use a test key prefix (MEMESTREAM_PREDICTIONS_PREFIX=memestream:pm-e2e:<run>:) and
 * MEMESTREAM_PREDICTIONS_FAST=1; `npm run e2e:predictions:local` sets both and runs this.
 *
 * Run:  BASE_URL=http://localhost:3000 MEMESTREAM_PREDICTIONS_PREFIX=memestream:pm-e2e:<run>: \
 *       KV_REST_API_URL=... KV_REST_API_TOKEN=... npx tsx scripts/predictions-e2e.mts
 *
 * Wallets: the streamer is .keys/devnet-creator.json; 4 viewers are .keys/e2e-viewer-N.json
 * (made on first run, reused, topped up to 0.05 SOL from .keys/partner.json); a non-holder is a
 * throwaway keypair. Each run launches a fresh coin, so every run starts at zero. At the end it
 * deletes only the Redis keys under the test prefix. Never prints secret keys.
 * If a run is stopped before its cleanup, rerun with E2E_CLEANUP_ONLY=1 and that run's prefix.
 */
import { createPrivateKey, sign } from "node:crypto";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { Redis } from "@upstash/redis";
import bs58 from "bs58";
import { MESSAGE_TTL_MS, newNonce, sessionMessage } from "../src/lib/predictions/message";
import { type Bet, payouts, type Side, STARTER_POINTS, SUGGEST_COST } from "../src/lib/predictions/rules";
import { sleep } from "../src/lib/poll";
import { connectToDevnet } from "./devnet";
import { readKeypair, readOrCreateKeypair } from "./keys";

const BASE_URL = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const PREFIX = process.env.MEMESTREAM_PREDICTIONS_PREFIX ?? "";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const VIEWERS = 4;
const VIEWER_SOL = 0.05;
const CREATOR_MIN_SOL = 0.06;
const CREATOR_TOPUP_SOL = 0.1;
const BUY_SOL = "0.002";
/** Pauses between HTTP calls, under every route's per-client limit, and between devnet RPC calls. */
const API_GAP_MS = 600;
const SIGN_IN_GAP_MS = 1_100;
const RPC_GAP_MS = 400;
const BEAT_GAP_MS = 52_000;

if (!BASE_URL && process.env.E2E_CLEANUP_ONLY !== "1") throw new Error("Set BASE_URL, e.g. http://localhost:3000");
if (!/^memestream:pm-e2e:[\w-]+:$/.test(PREFIX)) throw new Error("Set MEMESTREAM_PREDICTIONS_PREFIX=memestream:pm-e2e:<run id>: (the same one the server uses)");
if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Set the server's Upstash URL and token (KV_REST_API_URL / KV_REST_API_TOKEN), needed to check the prefix and clean up");

const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
/** E2E_CLEANUP_ONLY=1: only delete the keys of a run that was stopped before its own cleanup. */
const CLEANUP_ONLY = process.env.E2E_CLEANUP_ONLY === "1";
const connection = CLEANUP_ONLY ? null! : await connectToDevnet(); // refuses anything but devnet
const started = Date.now();
let failures = 0;

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

class Fatal extends Error {}
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s`;
const pass = (name: string, detail = "") => console.log(`PASS ${elapsed()}  ${name}${detail ? `  (${detail})` : ""}`);
function fail(name: string, detail: string) {
  failures += 1;
  console.log(`FAIL ${elapsed()}  ${name}  ${detail}`);
}
/** A step the rest of the run depends on: a failure stops the run (cleanup still happens). */
async function must<T>(name: string, run: () => Promise<T>, detail?: (value: T) => string): Promise<T> {
  try {
    const value = await run();
    pass(name, detail?.(value));
    return value;
  } catch (error) {
    fail(name, (error as Error).message);
    throw new Fatal(name);
  }
}
/** A check: a failure is reported and the run goes on. */
function check(name: string, ok: boolean, detail: string) {
  if (ok) pass(name, detail);
  else fail(name, detail);
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

type Reply = { status: number; json: Record<string, unknown> };
/** Request starts are spaced out, also when several run at once. */
let queue: Promise<unknown> = Promise.resolve();
async function http(method: "GET" | "POST", path: string, opts: { token?: string; body?: unknown; gapMs?: number } = {}): Promise<Reply> {
  const turn = queue.then(() => sleep(opts.gapMs ?? API_GAP_MS));
  queue = turn;
  await turn;
  const headers: Record<string, string> = { origin: BASE_URL };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}
async function ok<T = Record<string, unknown>>(method: "GET" | "POST", path: string, opts: Parameters<typeof http>[2] = {}): Promise<T> {
  const r = await http(method, path, opts);
  if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${String(r.json.error ?? "")}`);
  return r.json as T;
}

// ---------------------------------------------------------------------------------------------
// Devnet: funding, launch and buys through the app's own /api/tx routes
// ---------------------------------------------------------------------------------------------

const lamports = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);
const short = (k: Keypair) => k.publicKey.toBase58().slice(0, 6);

async function topUp(from: Keypair, wallets: { keypair: Keypair; min: number; target: number }[]) {
  const tx = new Transaction();
  for (const w of wallets) {
    await sleep(RPC_GAP_MS);
    const have = await connection.getBalance(w.keypair.publicKey);
    if (have < lamports(w.min)) tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: w.keypair.publicKey, lamports: lamports(w.target) - have }));
  }
  if (tx.instructions.length === 0) return "all funded already";
  const sig = await connection.sendTransaction(tx, [from]);
  await connection.confirmTransaction(sig, "confirmed");
  return `${tx.instructions.length} top-ups, ${sig.slice(0, 12)}…`;
}

/** Ask the server to build, sign locally, send to devnet, and wait on the server's own status route. */
async function sendViaApp(action: string, wallet: Keypair, body: Record<string, unknown>) {
  const prepared = await ok<{ transaction: string; blockhash: string; mint?: string }>("POST", `/api/tx/${action}`, {
    body: { wallet: wallet.publicKey.toBase58(), ...body },
    gapMs: 1_100,
  });
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

async function waitForHoldings(mint: string, wallet: Keypair, min: number) {
  for (let i = 0; i < 30; i++) {
    const r = await http("GET", `/api/coins/${mint}?wallet=${wallet.publicKey.toBase58()}`);
    const coins = Number((r.json.holdings as { coins?: string } | null)?.coins ?? 0);
    if (r.status === 200 && coins >= min) return coins;
    await sleep(3_000);
  }
  throw new Error(`${short(wallet)} never showed ${min}+ coins`);
}

// ---------------------------------------------------------------------------------------------
// Predictions players
// ---------------------------------------------------------------------------------------------

type Player = { name: string; keypair: Keypair; wallet: string; token: string };
type View = {
  now: number;
  me: { balance: number; eligible: boolean; watchMinutes: number; holder: boolean | null } | null;
  live: { id: string; text: string; lockAt: number; yes: number; no: number; bettors: number } | null;
  queue: { id: string; text: string; upvotes: number; mine: boolean }[];
  resolved: { id: string; outcome: string; disputed: boolean; my: { bet: number; payout: number; flagged: boolean } | null }[];
};

/** The exact message the server expects, signed with the wallet's ed25519 key (as a wallet's signMessage does). */
function signIn(keypair: Keypair) {
  const domain = new URL(BASE_URL).host;
  const message = sessionMessage({ domain, wallet: keypair.publicKey.toBase58(), nonce: newNonce(), expiresAt: Date.now() + MESSAGE_TTL_MS - 30_000 });
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(keypair.secretKey.slice(0, 32)).toString("base64url"), x: Buffer.from(keypair.publicKey.toBytes()).toString("base64url") },
    format: "jwk",
  });
  return { message, signature: bs58.encode(sign(null, Buffer.from(message), key)) };
}

let mint = "";
const coinPath = () => `/api/predictions/coin/${mint}`;
const view = (p: Player) => ok<View>("GET", coinPath(), { token: p.token });
const balance = async (p: Player) => (await view(p)).me!.balance;
const act = (p: Player, body: Record<string, unknown>) => http("POST", coinPath(), { token: p.token, body });
const beat = (p: Player) => http("POST", "/api/predictions/heartbeat", { token: p.token, body: { mint } });
async function actOk(p: Player, body: Record<string, unknown>) {
  const r = await act(p, body);
  if (r.status !== 200) throw new Error(`${p.name} ${String(body.kind)}: ${r.status} ${String(r.json.error ?? "")}`);
  return r.json as unknown as View;
}
/** An action the server must refuse with 400 and a message containing `expected`. */
async function refused(name: string, p: Player, body: Record<string, unknown>, expected: string) {
  const r = await act(p, body);
  const error = String(r.json.error ?? "");
  check(name, r.status === 400 && error.includes(expected), `${r.status} "${error}"`);
}
const balances = (players: Player[]) => Promise.all(players.map(balance));
async function waitUntilLocked(p: Player) {
  const v = await view(p);
  if (!v.live) throw new Error("nothing live");
  const ms = v.live.lockAt - v.now + 1_500;
  console.log(`      waiting ${Math.ceil(ms / 1000)} s for bets to lock`);
  await sleep(ms);
}

// ---------------------------------------------------------------------------------------------
// Cleanup: only keys under the test prefix
// ---------------------------------------------------------------------------------------------

async function prefixKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: `${PREFIX}*`, count: 500 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== "0");
  return keys.filter((k) => k.startsWith(PREFIX));
}

async function cleanup() {
  const keys = await prefixKeys();
  const kinds = new Map<string, number>();
  for (const k of keys) {
    const kind = k.slice(PREFIX.length).split(":")[0];
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  for (let i = 0; i < keys.length; i += 100) await redis.del(...keys.slice(i, i + 100));
  const left = await prefixKeys();
  check(
    "cleanup: deleted only the test prefix's keys",
    left.length === 0,
    `${keys.length} keys under ${PREFIX} (${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")}), ${left.length} left`,
  );
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

async function run() {
  console.log(`memestream predictions e2e  ${BASE_URL}  prefix ${PREFIX}`);
  const partner = readKeypair(".keys/partner.json");
  const creator = readKeypair(".keys/devnet-creator.json");
  const viewers = Array.from({ length: VIEWERS }, (_, i) => readOrCreateKeypair(`.keys/e2e-viewer-${i + 1}.json`));

  await must("fund: creator and viewers on devnet", () =>
    topUp(partner, [{ keypair: creator, min: CREATOR_MIN_SOL, target: CREATOR_TOPUP_SOL }, ...viewers.map((keypair) => ({ keypair, min: VIEWER_SOL * 0.6, target: VIEWER_SOL }))]),
  (d) => d);

  const symbol = `PE${Date.now().toString(36).slice(-6).toUpperCase()}`;
  const launched = await must(`launch: fresh coin $${symbol} by the streamer, through /api/tx/launch`, () =>
    sendViaApp("launch", creator, { name: "predictions e2e", symbol, streamUrl: "https://www.youtube.com/watch?v=4xDzrJKXOOY" }),
  (l) => `${l.mint} ${l.sig.slice(0, 12)}…`);
  mint = launched.mint!;

  for (const [i, v] of viewers.entries()) {
    await must(`buy: viewer ${i + 1} buys ${BUY_SOL} SOL of $${symbol} through /api/tx/trade`, () => sendViaApp("trade", v, { mint, side: "buy", amount: BUY_SOL }), (b) => b.sig.slice(0, 12) + "…");
  }
  for (const [i, v] of viewers.entries()) await must(`hold: viewer ${i + 1} holds 1+ whole coin`, () => waitForHoldings(mint, v, 1), (c) => `${c.toLocaleString("en")} coins`);

  // Sign in: the streamer, 4 viewers and a throwaway wallet that holds nothing.
  const outsider = Keypair.generate();
  const players: Player[] = [];
  let replay: ReturnType<typeof signIn> | null = null;
  for (const [name, keypair] of [["streamer", creator], ...viewers.map((v, i) => [`viewer${i + 1}`, v] as const), ["non-holder", outsider]] as const) {
    const signed = signIn(keypair);
    replay ??= signed;
    const s = await must(`sign-in: ${name} signs the session message`, () => ok<{ wallet: string; token: string }>("POST", "/api/predictions/session", { body: signed, gapMs: SIGN_IN_GAP_MS }), (r) => r.wallet.slice(0, 6));
    players.push({ name, keypair, wallet: s.wallet, token: s.token });
  }
  const replayed = await http("POST", "/api/predictions/session", { body: replay, gapMs: SIGN_IN_GAP_MS });
  check("sign-in: the same signed message again is refused (replay)", replayed.status === 400 && String(replayed.json.error).includes("already used"), `${replayed.status} "${String(replayed.json.error)}"`);

  const nonceKeys = (await prefixKeys()).filter((k) => k.startsWith(`${PREFIX}nonce:`));
  if (nonceKeys.length < players.length) {
    fail("prefix: the server stores under the test prefix", `${nonceKeys.length} nonce keys under ${PREFIX}; is the server using MEMESTREAM_PREDICTIONS_PREFIX?`);
    throw new Fatal("prefix");
  }
  pass("prefix: the server stores under the test prefix", `${nonceKeys.length} nonce keys`);

  const [streamer, v1, v2, v3, v4, outsiderP] = players;
  const watchers = [streamer, v1, v2, v3, v4];

  // Heartbeats: with FAST the starter grant comes after 1 minute watched (one beat).
  for (const [i, r] of (await Promise.all(watchers.map(beat))).entries()) {
    const p = watchers[i];
    check(`heartbeat 1: ${p.name}`, r.status === 200 && r.json.accepted === true && r.json.points === 2 + STARTER_POINTS, `accepted ${String(r.json.accepted)}, +${String(r.json.points)} points`);
  }
  const tooSoon = await beat(v1);
  check("heartbeat: a second beat within 50 s earns nothing", tooSoon.status === 200 && tooSoon.json.accepted === false && tooSoon.json.points === 0, JSON.stringify(tooSoon.json));
  const startBalances = await balances([v1, v2, v3, v4]);
  check("starter points: every viewer has 202 (2 + 200 starter)", startBalances.every((b) => b === 2 + STARTER_POINTS), startBalances.join(", "));
  const firstBeatsAt = Date.now();

  // Suggest: costs 10, holders only, never staff.
  const question = `Will the streamer win the next game? (${symbol})`;
  const afterSuggest = await must("suggest: viewer1 suggests a question", () => actOk(v1, { kind: "suggest", text: question }));
  const suggestion = afterSuggest.queue.find((s) => s.mine);
  check("suggest: costs 10 points", afterSuggest.me!.balance === startBalances[0] - SUGGEST_COST, `${startBalances[0]} -> ${afterSuggest.me!.balance}`);
  if (!suggestion) throw new Fatal("suggestion missing from the queue");
  await refused("suggest: a non-holder can't suggest", outsiderP, { kind: "suggest", text: "Will this be refused today?" }, "Hold at least");
  await refused("suggest: the streamer can't suggest on their own coin", streamer, { kind: "suggest", text: "Will this be refused today?" }, "can't suggest");
  await refused("upvote: not eligible before 2 minutes watched (FAST)", v2, { kind: "upvote", id: suggestion.id }, "Watch");

  // Second beats: 2 minutes watched, so upvotes count (FAST eligibility).
  const wait = firstBeatsAt + BEAT_GAP_MS - Date.now();
  console.log(`      waiting ${Math.ceil(wait / 1000)} s for the next heartbeat`);
  await sleep(wait);
  for (const [i, r] of (await Promise.all(watchers.map(beat))).entries()) {
    const p = watchers[i];
    check(`heartbeat 2: ${p.name}`, r.status === 200 && r.json.accepted === true && r.json.points === 2, `accepted ${String(r.json.accepted)}, +${String(r.json.points)} points`);
  }
  const v2View = await view(v2);
  check("eligible: viewers are eligible after 2 minutes watched", v2View.me!.eligible === true && v2View.me!.watchMinutes === 2, `eligible ${v2View.me!.eligible}, ${v2View.me!.watchMinutes} min`);

  // Upvotes: the third launches the suggestion by itself while the streamer is present.
  await must("upvote: viewer2", () => actOk(v2, { kind: "upvote", id: suggestion.id }));
  await refused("upvote: twice is refused", v2, { kind: "upvote", id: suggestion.id }, "already upvoted");
  await must("upvote: viewer3", () => actOk(v3, { kind: "upvote", id: suggestion.id }));
  const third = await must("upvote: viewer4 (the third upvote)", () => actOk(v4, { kind: "upvote", id: suggestion.id }));
  check("crowd launch: 3 upvotes put the question live", third.live?.id === suggestion.id && third.live?.text === question, `live ${third.live?.id ?? "none"}`);
  if (!third.live) throw new Fatal("crowd launch");
  const v1AfterLaunch = await balance(v1);
  check("suggest: the 10 points come back when it goes live", v1AfterLaunch === startBalances[0] + 2, `${v1AfterLaunch}`);

  // Bets on both sides; staff can't bet; a bettor can't resolve.
  const round1: Bet[] = [
    { wallet: v1.wallet, side: "yes", amount: 50 },
    { wallet: v2.wallet, side: "yes", amount: 30 },
    { wallet: v3.wallet, side: "no", amount: 40 },
    { wallet: v4.wallet, side: "no", amount: 20 },
  ];
  const byWallet = new Map(players.map((p) => [p.wallet, p]));
  const preBet = await balances([v1, v2, v3, v4]);
  for (const b of round1) await must(`bet: ${byWallet.get(b.wallet)!.name} ${b.amount} on ${b.side.toUpperCase()}`, () => actOk(byWallet.get(b.wallet)!, { kind: "bet", side: b.side, amount: b.amount }));
  await refused("bet: the streamer can't bet", streamer, { kind: "bet", side: "yes", amount: 10 }, "can't bet");
  await refused("bet: more than half the balance is refused", v2, { kind: "bet", side: "yes", amount: 100 }, "half");
  await refused("resolve: a viewer who bet can't resolve", v3, { kind: "resolve", outcome: "no" }, "Only the streamer or a mod");
  await refused("resolve: not while betting is open", streamer, { kind: "resolve", outcome: "yes" }, "still open");
  const pool1 = round1.reduce((t, b) => t + b.amount, 0);
  const live1 = (await view(v1)).live!;
  check("bets: pools add up", live1.yes === 80 && live1.no === 60 && live1.bettors === 4, `yes ${live1.yes}, no ${live1.no}, ${live1.bettors} bettors`);

  await waitUntilLocked(v1);
  await refused("bet: refused once locked", v1, { kind: "bet", side: "yes", amount: 10 }, "closed");
  const before1 = await balances([v1, v2, v3, v4]);
  await must("resolve: the streamer resolves YES", () => actOk(streamer, { kind: "resolve", outcome: "yes" }));
  const after1 = await balances([v1, v2, v3, v4]);
  const deltas1 = after1.map((b, i) => b - before1[i]);
  const expected1 = payouts(round1, "yes");
  check("payouts: total paid equals the pool", deltas1.reduce((t, d) => t + d, 0) === pool1, `paid ${deltas1.join("+")} = ${deltas1.reduce((t, d) => t + d, 0)}, pool ${pool1}`);
  check("payouts: each winner gets the parimutuel share", round1.every((b, i) => deltas1[i] === expected1.get(b.wallet)), `v1 +${deltas1[0]}, v2 +${deltas1[1]} (want ${expected1.get(v1.wallet)}, ${expected1.get(v2.wallet)})`);
  check("payouts: losers lose their stake", [2, 3].every((i) => deltas1[i] === 0 && after1[i] === preBet[i] - round1[i].amount), `v3 ${preBet[2]} -> ${after1[2]}, v4 ${preBet[3]} -> ${after1[3]}`);

  // Flags: bettors only, once each; 2 of 4 (50%) passes the 30% dispute line.
  const result1 = (await view(v3)).resolved[0];
  check("result: shows YES with my stake and payout", result1.outcome === "yes" && result1.my?.bet === 40 && result1.my?.payout === 0, JSON.stringify(result1.my));
  const flagged = await must("flag: viewer3 flags the result", () => actOk(v3, { kind: "flag", id: result1.id }));
  check("flag: 1 of 4 flags is not a dispute", flagged.resolved[0].my?.flagged === true && flagged.resolved[0].disputed === false, `disputed ${flagged.resolved[0].disputed}`);
  await refused("flag: twice is refused", v3, { kind: "flag", id: result1.id }, "already flagged");
  await refused("flag: a non-bettor can't flag", streamer, { kind: "flag", id: result1.id }, "Only its bettors");
  const disputed = await must("flag: viewer4 flags the result", () => actOk(v4, { kind: "flag", id: result1.id }));
  check("flag: 2 of 4 flags marks it disputed", disputed.resolved[0].disputed === true, `disputed ${disputed.resolved[0].disputed}`);

  // Round 2: the streamer types a question and launches it (1-minute window), then cancels: refunds.
  // Each call reads devnet, so the 4 bets go out together to fit in the minute.
  const preBet2 = await balances([v1, v2, v3, v4]);
  const launched2 = await must("launch: the streamer launches their own question (1 min)", () => actOk(streamer, { kind: "launch", text: `Will chat say gg first? (${symbol})`, windowMin: 1 }));
  check("launch: it is live", launched2.live !== null, launched2.live?.text ?? "none");
  const round2: { p: Player; side: Side; amount: number }[] = [
    { p: v1, side: "no", amount: 20 },
    { p: v2, side: "yes", amount: 20 },
    { p: v3, side: "yes", amount: 10 },
    { p: v4, side: "no", amount: 10 },
  ];
  await Promise.all(round2.map((b) => must(`bet: ${b.p.name} ${b.amount} on ${b.side.toUpperCase()}`, () => actOk(b.p, { kind: "bet", side: b.side, amount: b.amount }))));
  await refused("mod: a wallet with a live bet can't be made a mod", streamer, { kind: "mod", wallet: v4.wallet, add: true }, "has a bet");
  await refused("resolve: a viewer who bet can't resolve", v4, { kind: "resolve", outcome: "cancel" }, "Only the streamer or a mod");
  await waitUntilLocked(v1);
  const before2 = await balances([v1, v2, v3, v4]);
  await must("resolve: the streamer cancels", () => actOk(streamer, { kind: "resolve", outcome: "cancel" }));
  const after2 = await balances([v1, v2, v3, v4]);
  const refunds = after2.map((b, i) => b - before2[i]);
  check("cancel: every bettor gets their stake back", round2.every((b, i) => refunds[i] === b.amount && after2[i] === preBet2[i]), `refunds ${refunds.join(", ")}`);
  check("cancel: refunds add up to the pool", refunds.reduce((t, d) => t + d, 0) === round2.reduce((t, b) => t + b.amount, 0), `${refunds.reduce((t, d) => t + d, 0)}`);
}

try {
  if (!CLEANUP_ONLY) await run();
} catch (error) {
  if (!(error instanceof Fatal)) fail("unexpected error", (error as Error).message);
} finally {
  try {
    await cleanup();
  } catch (error) {
    fail("cleanup", (error as Error).message);
  }
}
const seconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(failures === 0 ? `\nALL PASS in ${seconds} s` : `\n${failures} FAILED in ${seconds} s`);
process.exit(failures === 0 ? 0 : 1);
