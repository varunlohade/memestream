/**
 * DEVNET ONLY: plays simulated users (alice, bob, carol) against a live memestream site, through
 * the same HTTP routes the browser uses. Keys live in .keys/sim-<name>.json (git-ignored, made on
 * first use); session tokens and funding totals live next to them. Never prints secret keys.
 *
 * Run:  npx tsx scripts/sim.mts <command> ...   (BASE_URL defaults to the live site)
 */
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Connection, type Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { MESSAGE_TTL_MS, newNonce, sessionMessage } from "../src/lib/predictions/message";
import { COIN_DECIMALS } from "../src/lib/api-types";
import { fractionOf } from "../src/lib/format";
import { OUTCOME_DECIMALS } from "../src/lib/markets/pool";
import { sleep } from "../src/lib/poll";
import { connectToDevnet } from "./devnet";
import { readKeypair, readOrCreateKeypair } from "./keys";

const BASE_URL = (process.env.BASE_URL ?? "https://memestream-iota.vercel.app").replace(/\/$/, "");
const USERS = ["alice", "bob", "carol"] as const;
/** Streamers: mapped to existing devnet keys, never created or copied. */
const CREATORS: Record<string, string> = { dave: ".keys/devnet-creator.json" };
const FUND_CAP_SOL = 0.5;
const SESSIONS = ".keys/sim-sessions.json";
const FUNDED = ".keys/sim-funded.json";
const API_GAP_MS = 1_100;
const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

const USAGE = `usage: npx tsx scripts/sim.mts <command>
  fund <name> <sol> | who | buy <name> <TICKER|mint> <sol> | sell <name> <TICKER|mint> <percent>
  signin <name> | suggest <name> <TICKER> "<question>" | upvote <name> <TICKER> <questionId>
  bet <name> <TICKER> <marketId> yes|no <sol> | sellbet <name> <TICKER> <marketId> yes|no <shares|N%>
  challenge <name> <TICKER> <marketId> "<reason>" | redeem <name> <TICKER> <marketId> | markets <TICKER>
  streamer: golive dave "<name>" <TICKER> <streamUrl> | launch dave <TICKER> "<question>"|<queueId>
            resolve dave <TICKER> <predictionId> yes|no|cancel
  names: ${USERS.join(", ")}; streamer: ${Object.keys(CREATORS).join(", ")}`;

class Stop extends Error {}
const solscan = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
const readJson = <T,>(path: string, empty: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : empty);
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });

function user(name: string | undefined): { name: string; keypair: Keypair; wallet: string } {
  if (name && CREATORS[name]) {
    const keypair = readKeypair(CREATORS[name]);
    return { name, keypair, wallet: keypair.publicKey.toBase58() };
  }
  if (!USERS.includes(name as (typeof USERS)[number])) throw new Stop(`Unknown user "${name}". Use ${USERS.join(", ")}.`);
  const keypair = readOrCreateKeypair(`.keys/sim-${name}.json`);
  return { name: name!, keypair, wallet: keypair.publicKey.toBase58() };
}

// ---------------------------------------------------------------------------------------------
// HTTP: spaced out, retried on 429 / 503 ("Busy") with backoff
// ---------------------------------------------------------------------------------------------

let lastCall = 0;
async function http(method: "GET" | "POST", path: string, opts: { token?: string; body?: unknown } = {}) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + API_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const headers: Record<string, string> = { origin: BASE_URL };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: "manual" });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const error = String(json.error ?? "");
    if ((res.status === 429 || res.status === 503 || /busy/i.test(error)) && attempt < 5) {
      await sleep(2_000 * 2 ** attempt);
      continue;
    }
    if (res.status === 409 && json.duplicate) throw new Stop(`409: ${error}${json.pendingSignature ? ` ${solscan(String(json.pendingSignature))}` : ""}`);
    if (res.status !== 200) throw new Stop(`${error || "request failed"} (${res.status} from ${method} ${path.split("?")[0]})`);
    return json;
  }
}

// ---------------------------------------------------------------------------------------------
// Transactions: the server builds, we sign locally and send, then poll the server's status route
// ---------------------------------------------------------------------------------------------

async function sendViaApp(connection: Connection, action: "launch" | "trade" | "market" | "market-redeem", u: ReturnType<typeof user>, body: Record<string, unknown>) {
  const prepared = (await http("POST", `/api/tx/${action}`, { body: { wallet: u.wallet, ...body } })) as { transaction: string; blockhash: string; intent?: string; mint?: string };
  const bytes = Buffer.from(prepared.transaction, "base64");
  let raw: Uint8Array;
  try {
    const tx = Transaction.from(bytes);
    tx.partialSign(u.keypair);
    raw = tx.serialize();
  } catch {
    const tx = VersionedTransaction.deserialize(bytes);
    tx.sign([u.keypair]);
    raw = tx.serialize();
  }
  const sig = await connection.sendRawTransaction(raw);
  const query = new URLSearchParams({ signature: sig, blockhash: prepared.blockhash, ...(prepared.intent ? { intent: prepared.intent } : {}) });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(3_000);
    const s = (await http("GET", `/api/tx/status?${query}`)) as { status: string; error?: string };
    if (s.status === "confirmed") return { sig, mint: prepared.mint };
    if (s.status === "failed") throw new Stop(`failed: ${s.error ?? ""} ${solscan(sig)}`);
  }
  throw new Stop(`no answer in 2 min ${solscan(sig)}`);
}

// ---------------------------------------------------------------------------------------------
// Coins, sessions, markets
// ---------------------------------------------------------------------------------------------

type Coin = { mint: string; symbol: string };
async function listedCoins(): Promise<Coin[]> {
  return ((await http("GET", "/api/coins")).coins as Coin[]).map((c) => ({ mint: c.mint, symbol: c.symbol }));
}

/** A ticker from /api/coins, else the /TICKER redirect, else a raw mint address (hidden test coins). */
async function resolveMint(ticker: string | undefined): Promise<Coin> {
  if (!ticker) throw new Stop("Name a coin (ticker or mint).");
  const hit = (await listedCoins()).find((c) => c.symbol.toUpperCase() === ticker.toUpperCase() || c.mint === ticker);
  if (hit) return hit;
  const res = await fetch(`${BASE_URL}/${encodeURIComponent(ticker)}`, { redirect: "manual" });
  const to = /\/coin\/(\w{32,44})/.exec(res.headers.get("location") ?? "");
  if (to) return { mint: to[1], symbol: ticker.toUpperCase() };
  try {
    new PublicKey(ticker);
    return { mint: ticker, symbol: `${ticker.slice(0, 6)}…` };
  } catch {
    throw new Stop(`No coin "${ticker}".`);
  }
}

function signedMessage(keypair: Keypair) {
  const message = sessionMessage({ domain: new URL(BASE_URL).host, wallet: keypair.publicKey.toBase58(), nonce: newNonce(), expiresAt: Date.now() + MESSAGE_TTL_MS - 30_000 });
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(keypair.secretKey.slice(0, 32)).toString("base64url"), x: Buffer.from(keypair.publicKey.toBytes()).toString("base64url") },
    format: "jwk",
  });
  return { message, signature: bs58.encode(sign(null, Buffer.from(message), key)) };
}

function streamer(name: string | undefined) {
  if (!name || !CREATORS[name]) throw new Stop(`Only a streamer can do that. Use ${Object.keys(CREATORS).join(", ")}.`);
  return user(name);
}

type Session = { token: string; expiresAt: number };
function sessionFor(u: ReturnType<typeof user>): string {
  const s = readJson<Record<string, Session>>(SESSIONS, {})[`${BASE_URL}|${u.name}`];
  if (!s || s.expiresAt <= Date.now()) throw new Stop(`${u.name} is not signed in. Run: signin ${u.name}`);
  return s.token;
}

type Prediction = { id: string; text: string; lockAt: number | null; yes?: number; no?: number; bettors?: number; market: string | null; outcome?: string; verdict?: { status: string; proposed?: string | null; finalAt?: number | null } | null };
type View = { live: Prediction[]; queue: { id: string; text: string; upvotes: number; status: string }[]; resolved: Prediction[] };

async function act(u: ReturnType<typeof user>, mint: string, body: Record<string, unknown>) {
  return http("POST", `/api/predictions/coin/${mint}`, { token: sessionFor(u), body });
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
async function odds(mint: string, predictionId: string, wallet?: string) {
  return (await http("POST", "/api/markets/odds", { body: { mint, predictionId, ...(wallet ? { wallet } : {}) } })) as {
    probability: { yes: number; no: number };
    trading: boolean;
    resolved: boolean;
    position: { yes: string; no: string } | null;
  };
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function main(args: string[]): Promise<string> {
  const [command, ...rest] = args;
  if (!command || command === "help") return USAGE;
  const connection = await connectToDevnet(); // refuses anything but devnet's genesis hash
  console.log("Reminder: alice, bob and carol are devnet test wallets; their activity is test activity, not real users.");

  switch (command) {
    case "fund": {
      const u = user(rest[0]);
      const sol = Number(rest[1]);
      if (!(sol > 0) || sol > FUND_CAP_SOL) throw new Stop(`Fund between 0 and ${FUND_CAP_SOL} SOL per call.`);
      const funded = readJson<Record<string, number>>(FUNDED, {});
      const total = (funded[u.wallet] ?? 0) + sol;
      if (total > FUND_CAP_SOL + 1e-9) throw new Stop(`${u.name} already got ${funded[u.wallet] ?? 0} SOL; the cap is ${FUND_CAP_SOL} SOL per user.`);
      const partner = readKeypair(".keys/partner.json");
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: partner.publicKey, toPubkey: u.keypair.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
      const sig = await connection.sendTransaction(tx, [partner]);
      await connection.confirmTransaction(sig, "confirmed");
      writeJson(FUNDED, { ...funded, [u.wallet]: total });
      return `fund ${u.name} ${sol} SOL ok (total funded ${total.toFixed(3)}) ${solscan(sig)}`;
    }

    case "who": {
      const coins = await listedCoins();
      const symbolOf = new Map(coins.map((c) => [c.mint, c.symbol]));
      const markets: { coin: Coin; id: string }[] = [];
      for (const coin of coins) {
        const v = (await http("GET", `/api/predictions/coin/${coin.mint}`)) as unknown as View;
        for (const p of [...v.live, ...v.resolved]) if (p.market && !["opening", "failed"].includes(p.market)) markets.push({ coin, id: p.id });
      }
      const lines: string[] = [];
      for (const name of USERS) {
        const u = user(name);
        const sol = (await connection.getBalance(u.keypair.publicKey)) / LAMPORTS_PER_SOL;
        const held: string[] = [];
        for (const programId of TOKEN_PROGRAMS) {
          const { value } = await connection.getParsedTokenAccountsByOwner(u.keypair.publicKey, { programId });
          for (const a of value) {
            const info = a.account.data.parsed.info as { mint: string; tokenAmount: { uiAmountString: string } };
            if (Number(info.tokenAmount.uiAmountString) > 0) held.push(`${symbolOf.get(info.mint) ?? info.mint.slice(0, 6) + "…"} ${info.tokenAmount.uiAmountString}`);
          }
        }
        for (const m of markets) {
          const p = (await odds(m.coin.mint, m.id, u.wallet)).position;
          if (p && (Number(p.yes) > 0 || Number(p.no) > 0)) held.push(`${m.coin.symbol}#${m.id} YES ${p.yes} NO ${p.no}`);
        }
        lines.push(`${name} ${u.wallet} ${sol.toFixed(4)} SOL | ${held.join(", ") || "no coins or shares"}`);
      }
      return lines.join("\n");
    }

    case "buy":
    case "sell": {
      const u = user(rest[0]);
      const coin = await resolveMint(rest[1]);
      const n = Number(rest[2]);
      let amount: string;
      if (command === "buy") {
        if (!(n > 0)) throw new Stop("Give the SOL to spend.");
        amount = String(n);
      } else {
        if (!(n > 0 && n <= 100)) throw new Stop("Give a percent from 1 to 100.");
        const detail = await http("GET", `/api/coins/${coin.mint}?wallet=${u.wallet}`);
        const have = (detail.holdings as { coins?: string } | null)?.coins ?? "0";
        amount = fractionOf(have, n, COIN_DECIMALS);
        if (!(Number(amount) > 0)) throw new Stop(`${u.name} holds no ${coin.symbol}.`);
      }
      const { sig } = await sendViaApp(connection, "trade", u, { mint: coin.mint, side: command, amount });
      return `${command} ${u.name} ${coin.symbol} ${amount}${command === "buy" ? " SOL" : " coins"} confirmed ${solscan(sig)}`;
    }

    case "signin": {
      const u = user(rest[0]);
      const s = (await http("POST", "/api/predictions/session", { body: signedMessage(u.keypair) })) as { token: string; expiresAt: number; granted: number };
      writeJson(SESSIONS, { ...readJson(SESSIONS, {}), [`${BASE_URL}|${u.name}`]: { token: s.token, expiresAt: s.expiresAt } });
      return `signin ${u.name} ok, +${s.granted} points, session until ${new Date(s.expiresAt).toISOString()} (no transaction)`;
    }

    case "suggest": {
      const u = user(rest[0]);
      const coin = await resolveMint(rest[1]);
      const v = (await act(u, coin.mint, { kind: "suggest", text: rest[2] ?? "" })) as unknown as View;
      const mine = v.queue?.find((q) => q.text === rest[2]);
      return `suggest ${u.name} ${coin.symbol} ok${mine ? ` id ${mine.id} (${mine.status})` : ""} (no transaction)`;
    }

    case "upvote": {
      const u = user(rest[0]);
      const coin = await resolveMint(rest[1]);
      await act(u, coin.mint, { kind: "upvote", id: rest[2] });
      return `upvote ${u.name} ${coin.symbol} #${rest[2]} ok (no transaction)`;
    }

    case "challenge": {
      const u = user(rest[0]);
      const coin = await resolveMint(rest[1]);
      await act(u, coin.mint, { kind: "challenge", id: rest[2], reason: rest[3] ?? "" });
      return `challenge ${u.name} ${coin.symbol} #${rest[2]} ok (no transaction)`;
    }

    case "bet":
    case "sellbet": {
      const u = user(rest[0]);
      const coin = await resolveMint(rest[1]);
      const [, , predictionId, side, given] = rest;
      if (side !== "yes" && side !== "no") throw new Stop("Side must be yes or no.");
      let amount = given;
      if (command === "sellbet" && given?.endsWith("%")) {
        const share = Number(given.slice(0, -1));
        if (!(share > 0 && share <= 100)) throw new Stop("Give a percent from 1 to 100.");
        const have = (await odds(coin.mint, predictionId, u.wallet)).position?.[side] ?? "0";
        amount = fractionOf(have, share, OUTCOME_DECIMALS);
        if (!(Number(amount) > 0)) throw new Stop(`${u.name} holds no ${side.toUpperCase()} shares on #${predictionId}.`);
      }
      if (!(Number(amount) > 0)) throw new Stop("Give a positive amount.");
      const action = command === "bet" ? "buy" : "sell";
      const { sig } = await sendViaApp(connection, "market", u, { mint: coin.mint, predictionId, side, action, amount }).catch((e: unknown) => {
        if (e instanceof Stop && /No market for this prediction/.test(e.message)) throw new Stop(`${e.message}. The market may still be opening (about 30 s after launch): run markets ${rest[1]}.`);
        throw e;
      });
      return `${command} ${u.name} ${coin.symbol}#${predictionId} ${side.toUpperCase()} ${amount}${action === "buy" ? " SOL" : " shares"} confirmed ${solscan(sig)}`;
    }

    case "redeem": {
      const u = user(rest[0]);
      const coin = await resolveMint(rest[1]);
      const v = (await http("GET", `/api/predictions/coin/${coin.mint}`)) as unknown as View;
      const p = v.resolved.find((x) => x.id === rest[2]);
      if (!p) throw new Stop(`redeem: #${rest[2]} is not resolved yet; nothing to redeem.`);
      const status = p.verdict?.status;
      if (status === "proposed") throw new Stop(`redeem: #${rest[2]} is not final yet (proposed ${p.verdict?.proposed?.toUpperCase()}, final ${p.verdict?.finalAt ? new Date(p.verdict.finalAt).toISOString() : "later"} unless challenged).`);
      if (status === "disputed") throw new Stop(`redeem: #${rest[2]} is not final yet (disputed; the admin decides).`);
      const { sig } = await sendViaApp(connection, "market-redeem", u, { mint: coin.mint, predictionId: rest[2] });
      return `redeem ${u.name} ${coin.symbol}#${rest[2]} confirmed ${solscan(sig)}`;
    }

    case "golive": {
      const u = streamer(rest[0]);
      const [, name, symbol, streamUrl] = rest;
      if (!name || !symbol || !streamUrl) throw new Stop('Usage: golive dave "<name>" <TICKER> <streamUrl>');
      const { sig, mint } = await sendViaApp(connection, "launch", u, { name, symbol, streamUrl });
      return `golive ${u.name} $${symbol.toUpperCase()} mint ${mint} confirmed ${solscan(sig)}`;
    }

    case "launch": {
      const u = streamer(rest[0]);
      const coin = await resolveMint(rest[1]);
      const what = rest[2] ?? "";
      if (!what) throw new Stop('Give a question in quotes, or a queue id.');
      const fromQueue = /^[1-9][0-9]*$/.test(what);
      const v = (await act(u, coin.mint, fromQueue ? { kind: "launch", id: what } : { kind: "launch", text: what })) as unknown as View;
      const hit = (v.live ?? []).find((p) => (fromQueue ? p.id === what : p.text === what));
      const lock = hit?.lockAt ? `, betting closes in ${Math.round((hit.lockAt - Date.now()) / 1000)} s` : "";
      return `launch ${u.name} ${coin.symbol} ok${hit ? ` id ${hit.id} market ${hit.market ?? "none"}${lock}` : ", the AI is reviewing it: run markets in ~20 s for its id"} (no transaction)`;
    }

    case "resolve": {
      const u = streamer(rest[0]);
      const coin = await resolveMint(rest[1]);
      const outcome = rest[3];
      if (outcome !== "yes" && outcome !== "no" && outcome !== "cancel") throw new Stop("Outcome must be yes, no or cancel.");
      await act(u, coin.mint, { kind: "resolve", id: rest[2], outcome });
      return `resolve ${u.name} ${coin.symbol} #${rest[2]} ${outcome.toUpperCase()} ok (no transaction)`;
    }

    case "markets": {
      const coin = await resolveMint(rest[0]);
      const v = (await http("GET", `/api/predictions/coin/${coin.mint}`)) as unknown as View;
      const parts: string[] = [];
      for (const p of v.live) {
        let price = "";
        if (p.market === "open" || p.market === "closed") {
          const o = await odds(coin.mint, p.id);
          price = ` YES ${pct(o.probability.yes)} NO ${pct(o.probability.no)}`;
        }
        const left = p.lockAt ? Math.round((p.lockAt - Date.now()) / 1000) : null;
        const closes = left === null ? "" : left > 0 ? ` betting closes in ${left} s` : " betting closed";
        parts.push(`live #${p.id} "${p.text}" market ${p.market ?? "none"}${price}${closes}`);
      }
      for (const p of v.resolved) parts.push(`resolved #${p.id} "${p.text}" ${p.outcome} market ${p.market ?? "none"}${p.verdict ? ` ${p.verdict.status}` : ""}`);
      for (const q of v.queue) parts.push(`queue #${q.id} "${q.text}" ${q.upvotes} up (${q.status})`);
      return `markets ${coin.symbol} (${coin.mint}): ${parts.length ? parts.join(" | ") : "no live questions, markets or queue"}`;
    }
  }
  throw new Stop(USAGE);
}

try {
  console.log(await main(process.argv.slice(2)));
} catch (error) {
  console.log(error instanceof Stop ? error.message : `error: ${(error as Error).message}`);
  process.exitCode = 1;
}
