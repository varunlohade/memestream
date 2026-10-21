/**
 * One run of the daily stream job: our own devnet streamer launches a coin on a 24/7 live cam,
 * then asks 2-3 yes/no questions the AI referee can check from the stream picture. It goes through
 * the site's public API, the same routes the Go Live page and the predictions panel use.
 *
 * Before any transaction it checks that the RPC is devnet (genesis hash) and the site says devnet,
 * and that the streamer has not launched today. If today's coin exists (a run stopped part way) it
 * resumes: no second launch, only the missing questions. It logs one line per step and never the key.
 */
import { DEVNET_CONFIG, DEVNET_GENESIS_HASH, keypairFromSecret, parseTransaction, rpcClient, signTransaction, base58Encode } from "./solana.mjs";
import { coinFor, rotation, STREAMS, utcDay } from "./streams.mjs";

const LAMPORTS_PER_SOL = 1_000_000_000;
/** Covers rent for the mint, pool and metadata plus fees; the launch fee comes on top. */
export const MIN_BALANCE_SOL = 0.05;
export const MAX_QUESTIONS = 3;
export const MIN_QUESTIONS = 2;
const API_GAP_MS = 1_100;
/** Network errors and 5xx answers are retried this many times, 2, 4, then 8 s apart. */
const TRANSIENT_RETRIES = 3;
const CONFIRM_TIMEOUT_MS = 120_000;
const REVIEW_TIMEOUT_MS = 4 * 60_000;
const POLL_MS = 5_000;
const COIN_READY_TIMEOUT_MS = 90_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/** The today check pages through the streamer's signatures until yesterday, at most this many. */
export const MAX_SIGNATURE_SCAN = 500;
const SIGNATURE_PAGE = 100;

class Stop extends Error {}
/** A network error or a 5xx answer: worth another try. */
class Transient extends Stop {}

/** Reads and checks the settings. Error messages never include the key or the RPC URL (it may hold an API key). */
export function configFrom(env) {
  let site;
  try {
    site = new URL(env.DAILY_SITE_URL ?? "");
  } catch {
    throw new Error("Set DAILY_SITE_URL, e.g. https://www.memestream.lol");
  }
  if (site.protocol !== "https:" || site.pathname !== "/" || site.search || site.hash || site.username || site.password) {
    throw new Error("DAILY_SITE_URL must be a plain https origin, e.g. https://www.memestream.lol");
  }
  let rpc;
  try {
    rpc = new URL(env.DAILY_RPC_URL ?? "");
  } catch {
    throw new Error("Set DAILY_RPC_URL to a devnet RPC, e.g. https://api.devnet.solana.com");
  }
  if (rpc.protocol !== "https:") throw new Error("DAILY_RPC_URL must be https");
  if (/mainnet/i.test(rpc.hostname)) throw new Error("DAILY_RPC_URL names mainnet; the daily stream job runs on devnet only");
  if (!env.DAILY_STREAMER_KEY) throw new Error("Set DAILY_STREAMER_KEY (base58 secret key of the devnet-only streamer wallet)");
  return { siteUrl: site.origin, rpcUrl: rpc.href, rpcHost: rpc.host, keypair: keypairFromSecret(env.DAILY_STREAMER_KEY), dryRun: env.DAILY_DRY_RUN === "1" };
}

/** The cluster and label the site's own page shows: the wallet chain in its page data and the "Devnet" badge. */
export function siteNetwork(html) {
  const label = /class="net">([^<]{1,40})</.exec(html)?.[1]?.trim() ?? null;
  if (html.includes("solana:mainnet")) return { chain: "solana:mainnet", label };
  const chain = /\\?"chain\\?"\s*:\s*\\?"(solana:[a-z-]+)\\?"/.exec(html)?.[1] ?? null;
  return { chain, label };
}

/** true / false from a YouTube watch page's own live flag; null when the page doesn't say (blocked, consent page). */
export function youtubeLive(html) {
  const now = /"isLiveNow":(true|false)/.exec(html)?.[1];
  if (now) return now === "true";
  return /"isLiveContent":false/.test(html) ? false : null;
}

/** The predictions sign-in message; the same text as src/lib/predictions/message.ts (a test checks it). */
export const STATEMENT = "memestream predictions: free points, no money, no prizes. Signing in costs nothing and sends nothing.";
export function sessionMessage({ domain, wallet, nonce, expiresAt }) {
  return [`${domain} wants you to sign in with your Solana account:`, wallet, "", STATEMENT, "", `Nonce: ${nonce}`, `Expiration Time: ${new Date(expiresAt).toISOString()}`].join("\n");
}
const MESSAGE_TTL_MS = 5 * 60_000;


/**
 * Runs the job once; resolves to the exit code. `deps`: env, fetch, now(), sleep(ms), log(line).
 * Exit 0: done, or already done today. Exit 1: a check failed or the run stopped part way.
 */
export async function runDaily({ env, fetch: doFetch = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  const say = (line) => log(`daily: ${line}`);
  let cfg;
  try {
    cfg = configFrom(env);
  } catch (error) {
    say(`config: ${error.message}`);
    return 1;
  }
  const { keypair, dryRun } = cfg;
  const me = keypair.publicKey;
  const rpc = rpcClient(cfg.rpcUrl, doFetch);
  const t0 = now();
  /** Where the API is called (DAILY_SITE_URL, or where it redirects). */
  let base = cfg.siteUrl;
  /** The server's own public URL (MEMESTREAM_PUBLIC_URL): the Origin header and the sign-in domain. */
  let origin = cfg.siteUrl;

  let lastCall = 0;
  /**
   * The site's API, spaced out and retried on 429 / 503 ("Busy") like scripts/sim.mts. With `retry`,
   * network errors and other 5xx answers are retried too; without it they throw Transient.
   */
  async function api(method, path, { token, body, retry = false } = {}) {
    let busyTries = 0;
    let transientTries = 0;
    for (;;) {
      const wait = lastCall + API_GAP_MS - now();
      if (wait > 0) await sleep(wait);
      lastCall = now();
      const headers = { origin };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (token) headers.authorization = `Bearer ${token}`;
      const where = `${method} ${path.split("?")[0]}`;
      let res;
      try {
        res = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(130_000) });
      } catch {
        if (retry && transientTries < TRANSIENT_RETRIES) {
          await sleep(2_000 * 2 ** transientTries++);
          continue;
        }
        throw new Transient(`network error on ${where}`);
      }
      const json = await res.json().catch(() => ({}));
      const error = String(json.error ?? "");
      if ((res.status === 429 || res.status === 503 || /busy/i.test(error)) && busyTries < 5) {
        await sleep(2_000 * 2 ** busyTries++);
        continue;
      }
      if (res.status >= 500) {
        if (retry && transientTries < TRANSIENT_RETRIES) {
          await sleep(2_000 * 2 ** transientTries++);
          continue;
        }
        throw new Transient(`${error || "server error"} (${res.status} from ${where})`);
      }
      if (res.status !== 200) throw new Stop(`${error || "request failed"} (${res.status} from ${where})`);
      return json;
    }
  }

  async function page(url, redirect) {
    const res = await doFetch(url, { headers: { "user-agent": "Mozilla/5.0 (memestream daily)", "accept-language": "en", cookie: "SOCS=CAI" }, redirect, signal: AbortSignal.timeout(30_000) });
    const text = res.status === 200 ? await res.text() : "";
    return { res, text: text.length > MAX_PAGE_BYTES ? text.slice(0, MAX_PAGE_BYTES) : text };
  }

  /** Live per the watch page's own flag (redirects followed: consent pages); null when it can't tell. */
  async function isLive(stream) {
    const watch = await page(stream.url, "follow").catch(() => null);
    return watch ? youtubeLive(watch.text) : null;
  }

  /**
   * The streamer's successful transaction today (it pays only for launches), paging back until
   * yesterday. Too many to read means it can't tell: stop rather than risk a second launch.
   */
  async function paidToday(dayStart) {
    let before;
    for (let scanned = 0; scanned < MAX_SIGNATURE_SCAN; ) {
      const sigs = await rpc("getSignaturesForAddress", [me, { limit: SIGNATURE_PAGE, commitment: "confirmed", ...(before ? { before } : {}) }]);
      for (const s of sigs) {
        scanned++;
        if (s.blockTime != null && s.blockTime * 1000 < dayStart) return null;
        if (s.err) continue;
        const tx = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
        const message = tx?.transaction?.message;
        if (message?.accountKeys?.[0] === me) return { signature: s.signature, mint: message.header?.numRequiredSignatures >= 2 ? message.accountKeys[1] : null };
      }
      if (sigs.length < SIGNATURE_PAGE) return null;
      before = sigs.at(-1).signature;
    }
    throw new Stop(`today: more than ${MAX_SIGNATURE_SCAN} transactions today; can't tell if a coin launched; not launching`);
  }

  /** A fresh message per try: a nonce is used once, so a lost answer can't be retried as is. */
  async function signIn() {
    for (let attempt = 0; ; attempt++) {
      const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
      const message = sessionMessage({ domain: new URL(origin).host, wallet: me, nonce, expiresAt: now() + MESSAGE_TTL_MS - 30_000 });
      const signature = base58Encode(keypair.sign(Buffer.from(message)));
      try {
        return (await api("POST", "/api/predictions/session", { body: { message, signature } })).token;
      } catch (error) {
        if (!(error instanceof Transient) || attempt >= TRANSIENT_RETRIES) throw error;
        await sleep(2_000 * 2 ** attempt);
      }
    }
  }

  /** Waits for the AI review of `text`: live (it picked the window), rejected, stuck or too slow. */
  async function review(mint, token, text) {
    const deadline = now() + REVIEW_TIMEOUT_MS;
    while (now() < deadline) {
      await sleep(POLL_MS);
      const view = await api("GET", `/api/predictions/coin/${mint}`, { token, retry: true }).catch(() => null);
      if (!view) continue;
      if (view.pending?.text === text) {
        if (view.pending.stuck) return { result: "stuck" };
        continue;
      }
      const hit = (view.live ?? []).find((p) => p.text === text);
      if (hit) return { result: "live", id: hit.id, closesInMin: Math.round((hit.lockAt - now()) / 60_000) };
      return { result: "rejected", why: view.me?.notice ?? "no reason given" };
    }
    return { result: "timeout" };
  }

  /** Asks one question. A post whose answer was lost may have landed: then it is "under review", and we wait for it. */
  async function ask(mint, token, text) {
    try {
      await api("POST", `/api/predictions/coin/${mint}`, { token, body: { kind: "launch", text }, retry: true });
    } catch (error) {
      if (!/under review/i.test(error.message)) throw error;
    }
    say(`question: asked "${text}"; waiting for the AI review`);
    return review(mint, token, text);
  }

  /** Signs in and asks the stream's questions until MAX_QUESTIONS are live or done, counting those the coin already has. */
  async function askQuestions(mint, stream) {
    let ready = null;
    for (const deadline = now() + COIN_READY_TIMEOUT_MS; !ready; ) {
      ready = await api("GET", `/api/predictions/coin/${mint}`, { retry: true }).catch(() => null);
      if (ready) break;
      if (now() >= deadline) throw new Stop("questions: the coin's predictions did not load; no questions asked");
      await sleep(POLL_MS);
    }
    const asked = (ready.live ?? []).length + (ready.resolved ?? []).length;
    if (asked >= MAX_QUESTIONS) {
      say(`questions: the coin already has ${asked}; nothing to ask`);
      return asked;
    }
    const token = await signIn();
    say("signin: ok (no transaction)");
    const view = await api("GET", `/api/predictions/coin/${mint}`, { token, retry: true });
    const used = new Set([...(view.live ?? []), ...(view.resolved ?? [])].map((p) => p.text));
    let count = used.size;
    if (count) say(`questions: the coin already has ${count}`);
    /** Logs a review's result; false means stop asking (stuck or too slow: the next can't go in). */
    const tally = (r) => {
      if (r.result === "live") {
        count++;
        say(`question: live #${r.id}, betting closes in about ${r.closesInMin} min`);
      } else if (r.result === "rejected") {
        say(`question: not approved (${r.why}); trying the next one`);
      } else {
        say(`question: the review ${r.result === "stuck" ? "is stuck" : "took too long"}; no more questions`);
        return false;
      }
      return true;
    };
    if (view.pending) {
      used.add(view.pending.text);
      say(`question: "${view.pending.text}" is already under review; waiting for it`);
      if (!tally(await review(mint, token, view.pending.text))) return count;
    }
    for (const text of stream.questions) {
      if (count >= MAX_QUESTIONS) break;
      if (used.has(text)) continue;
      if (!tally(await ask(mint, token, text))) break;
    }
    return count;
  }

  /** Builds, checks, signs and sends the launch; resolves once the site sees it confirmed. */
  async function launch(coin) {
    const prepared = await api("POST", "/api/tx/launch", { body: { wallet: me, ...coin } });
    const bytes = Buffer.from(prepared.transaction, "base64");
    const tx = parseTransaction(bytes);
    if (tx.feePayer !== me) throw new Stop("launch: the site's transaction is not paid by the streamer; not signing");
    if (!tx.accountKeys.includes(DEVNET_CONFIG)) throw new Stop("launch: the site's transaction does not use the devnet config; not signing");
    const signed = signTransaction(bytes, keypair);
    const signature = await rpc("sendTransaction", [Buffer.from(signed).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
    say(`launch: sent $${coin.symbol} mint ${prepared.mint}, tx ${signature}`);
    const query = new URLSearchParams({ signature, blockhash: prepared.blockhash, ...(prepared.intent ? { intent: prepared.intent } : {}) });
    for (const deadline = now() + CONFIRM_TIMEOUT_MS; ; ) {
      if (now() >= deadline) throw new Stop(`launch: no confirmation in ${CONFIRM_TIMEOUT_MS / 1000} s (tx ${signature}); the next run checks the chain and resumes`);
      await sleep(3_000);
      const s = await api("GET", `/api/tx/status?${query}`, { retry: true });
      if (s.status === "confirmed") break;
      if (s.status === "failed") throw new Stop(`launch: failed: ${s.error ?? "unknown"} (tx ${signature})`);
      if (s.status === "expired") {
        const [st] = (await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value;
        if (st && !st.err && ["confirmed", "finalized"].includes(st.confirmationStatus)) break;
        throw new Stop(`launch: expired before it landed (tx ${signature}); nothing launched`);
      }
    }
    say(`launch: confirmed ${origin}/coin/${prepared.mint}`);
    return prepared.mint;
  }

  try {
    say(`start: site ${cfg.siteUrl}, rpc ${cfg.rpcHost}, streamer ${me}${dryRun ? ", DRY RUN (no transaction, no sign-in)" : ""}`);

    const genesis = await rpc("getGenesisHash");
    if (genesis !== DEVNET_GENESIS_HASH) throw new Stop(`rpc: genesis hash ${genesis} is not devnet's; stopping, no transaction`);
    say("rpc: devnet (genesis hash matches)");

    let home = await page(`${base}/`, "manual");
    const moved = home.res.status >= 300 && home.res.status < 400 ? home.res.headers.get("location") : null;
    if (moved) {
      const to = new URL(moved, base);
      if (to.protocol !== "https:") throw new Stop(`site: redirects to a non-https URL; stopping, no transaction`);
      base = origin = to.origin;
      say(`site: ${cfg.siteUrl} redirects to ${base}; using it`);
      home = await page(`${base}/`, "manual");
    }
    const net = siteNetwork(home.text);
    if (net.chain !== "solana:devnet" || !/devnet/i.test(net.label ?? "")) throw new Stop(`site: says ${net.chain ?? "no chain"} / ${net.label ?? "no label"}, not devnet; stopping, no transaction`);
    say(`site: devnet (chain ${net.chain}, label "${net.label}")`);

    const coins = (await api("GET", "/api/coins", { retry: true })).coins ?? [];
    // The server's MEMESTREAM_PUBLIC_URL is in every coin's metadata (external_url): Origin and sign-in must match it.
    if (coins[0]) {
      const meta = await api("GET", `/api/meta/${coins[0].mint}`, { retry: true }).catch(() => null);
      const pub = meta?.external_url ? new URL(meta.external_url) : null;
      if (pub?.protocol === "https:" && pub.origin !== origin) {
        say(`site: the server's public URL is ${pub.origin}, not ${origin}; using it for Origin and sign-in`);
        origin = pub.origin;
      } else if (!pub) say(`site: could not read the server's public URL; using ${origin}`);
    }

    const [dayStart] = utcDay(t0);
    let today = coins.find((c) => c.creator === me && c.launchedAt * 1000 >= dayStart) ?? null;
    if (!today) {
      const paid = await paidToday(dayStart);
      if (paid) {
        const detail = paid.mint ? await api("GET", `/api/coins/${paid.mint}`, { retry: true }).catch(() => null) : null;
        if (detail?.coin?.creator !== me) throw new Stop(`today: the streamer already sent a transaction today (${paid.signature}) but its coin can't be read; not launching again`);
        today = detail.coin;
      }
    }

    let mint;
    let stream;
    if (today) {
      stream = STREAMS.find((s) => s.url === today.streamUrl);
      say(`today: already launched $${today.symbol} (${today.mint}); resuming its questions, no second launch`);
      if (!stream) throw new Stop("today: its stream is not in the daily list; no questions asked");
      if (dryRun) {
        say("dry run: would sign in and ask the missing questions; no transaction sent");
        return 0;
      }
      mint = today.mint;
    } else {
      say("today: no daily coin launched yet (site list and chain checked)");
      const fee = Number((await api("GET", "/api/launch-fee", { retry: true })).sol ?? NaN);
      const needSol = MIN_BALANCE_SOL + (Number.isFinite(fee) ? fee : 0);
      const haveSol = (await rpc("getBalance", [me, { commitment: "confirmed" }])).value / LAMPORTS_PER_SOL;
      const funded = haveSol >= needSol;
      say(`balance: ${haveSol.toFixed(4)} SOL; need ${needSol} (launch fee ${Number.isFinite(fee) ? fee : "unknown"} SOL)`);
      if (!funded && !dryRun) throw new Stop("balance: too low; fund the streamer with devnet SOL (see daily/README.md)");

      for (const s of rotation(t0, STREAMS)) {
        const live = await isLive(s);
        if (!live) {
          say(`stream: ${s.key} ${live === false ? "is not live" : "could not tell if live"}; skipped`);
          continue;
        }
        const coin = coinFor(s, t0);
        if (coins.some((c) => c.symbol === coin.symbol)) {
          say(`stream: ${s.key} is live but $${coin.symbol} is taken; next cam`);
          continue;
        }
        say(`stream: ${s.key} is live`);
        if (dryRun) {
          say(`dry run: would launch "${coin.name}" $${coin.symbol} on ${coin.streamUrl}`);
          say(`dry run: would sign in and ask up to ${MAX_QUESTIONS} of: ${s.questions.map((q) => `"${q}"`).join(", ")}`);
          if (!funded) {
            say(`dry run: a real run would stop at the balance check (${haveSol.toFixed(4)} < ${needSol} SOL)`);
            return 1;
          }
          say("dry run: every check passed; no transaction sent");
          return 0;
        }
        try {
          mint = await launch(coin);
        } catch (error) {
          if (!/is taken/i.test(error.message)) throw error;
          say(`launch: $${coin.symbol} is taken; next cam`);
          continue;
        }
        stream = s;
        break;
      }
      if (!mint) throw new Stop("stream: no live cam with a free ticker; no launch");
    }

    const live = await askQuestions(mint, stream);
    say(`done: ${live} question${live === 1 ? "" : "s"} live or done on ${mint}`);
    return live >= MIN_QUESTIONS ? 0 : 1;
  } catch (error) {
    say(error instanceof Stop ? error.message : `error: ${error.message}`);
    return 1;
  }
}
