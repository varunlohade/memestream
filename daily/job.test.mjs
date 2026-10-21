import assert from "node:assert/strict";
import { test } from "node:test";
import { configFrom, MAX_SIGNATURE_SCAN, runDaily, siteNetwork, youtubeLive } from "./job.mjs";
import { DEVNET_CONFIG, DEVNET_GENESIS_HASH, keypairFromSecret } from "./solana.mjs";
import { rotation, STREAMS } from "./streams.mjs";
import { fakeTx, newSecret } from "./test-helpers.mjs";

const SITE = "https://site.test";
const RPC = "https://rpc.test/?api-key=SECRETRPCKEY";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const NOW = Date.parse("2026-10-22T09:00:00Z");
const TODAY_S = Date.parse("2026-10-22T00:00:00Z") / 1000;
const DEVNET_PAGE = `<a><span class="wm">memestream</span><span class="net">Devnet</span></a><script>self.__next_f.push([1,"[\\"$\\",\\"$La\\",null,{\\"chain\\":\\"solana:devnet\\"}]"])</script>`;
const LIVE_PAGE = `..."isLiveNow":true,...`;
const ENDED_PAGE = `..."isLiveContent":false,...`;
const CONSENT_PAGE = "<html>Before you continue to YouTube</html>";
const OTHER_COIN = { creator: "Someone1111111111111111111111111111111111", symbol: "THAI", mint: "OtherMint111111111111111111111111111111111", launchedAt: 1 };

/**
 * A fake devnet RPC, YouTube and memestream site that checks Origin and the sign-in domain like the
 * real routes (against `publicUrl`), recording every call. `opts` changes one thing from a run that
 * should launch: genesis, sitePage, redirectTo, publicUrl, coins, detail, signatures, balance,
 * liveKeys, consentKeys (watch page says nothing), reject (question texts jev rejects),
 * statuses (tx status answers in order), chainStatus, flaky ({ "METHOD /path": number of 500s first }),
 * takenAtBuild (tickers the launch build refuses), game (the coin's existing predictions).
 */
function world(opts = {}) {
  const secret = opts.secret ?? newSecret();
  const kp = keypairFromSecret(secret);
  const mint = opts.mint ?? keypairFromSecret(newSecret()).publicKey;
  const publicUrl = opts.publicUrl ?? SITE;
  const calls = { rpc: [], site: [], youtube: [], thumbs: [], origins: [], sent: 0, signins: [] };
  const game = { pending: null, live: [], resolved: [], notice: null, nextId: 1, ...opts.game };
  const reject = new Set(opts.reject ?? []);
  const liveKeys = opts.liveKeys ?? STREAMS.map((s) => s.key);
  const flaky = { ...opts.flaky };
  const statuses = [...(opts.statuses ?? [])];
  const signatures = opts.signatures ?? [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function doFetch(url, init = {}) {
    if (url === RPC) {
      const { method, params } = JSON.parse(init.body);
      calls.rpc.push(method);
      let result;
      if (method === "getGenesisHash") result = opts.genesis ?? DEVNET_GENESIS_HASH;
      if (method === "getSignaturesForAddress") {
        const { limit, before } = params[1];
        const from = before ? signatures.findIndex((s) => s.signature === before) + 1 : 0;
        result = signatures.slice(from, from + limit);
      }
      if (method === "getTransaction") {
        const sig = signatures.find((s) => s.signature === params[0]);
        result = { transaction: { message: { header: { numRequiredSignatures: 2 }, accountKeys: [sig.payer ?? kp.publicKey, sig.mint ?? mint] } } };
      }
      if (method === "getBalance") result = { value: (opts.balance ?? 0.2) * 1e9 };
      if (method === "sendTransaction") {
        calls.sent++;
        result = "SIG111";
      }
      if (method === "getSignatureStatuses") result = { value: [opts.chainStatus ?? null] };
      return json({ jsonrpc: "2.0", id: 1, result });
    }
    if (url.startsWith("https://www.youtube.com/")) {
      calls.youtube.push([url, init.redirect]);
      const stream = STREAMS.find((s) => s.url === url);
      if ((opts.consentKeys ?? []).includes(stream.key)) return new Response(CONSENT_PAGE);
      return new Response(liveKeys.includes(stream.key) ? LIVE_PAGE : ENDED_PAGE);
    }
    if (url.startsWith("https://i.ytimg.com/")) {
      calls.thumbs.push(url);
      return new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (opts.redirectTo && url.startsWith(`${opts.redirectTo.from}/`)) {
      calls.site.push(`redirect ${url}`);
      return new Response(null, { status: 308, headers: { location: `${SITE}/` } });
    }
    assert.ok(url.startsWith(`${SITE}/`), `only the site: ${url}`);
    const path = url.slice(SITE.length);
    const method = init.method ?? "GET";
    const route = `${method} ${path.split("?")[0]}`;
    calls.site.push(route);
    calls.origins.push(init.headers?.origin);
    if (route === "POST /api/predictions/session") calls.signins.push(JSON.parse(init.body).message);
    if (flaky[route] > 0) {
      flaky[route]--;
      return json({ error: "upstream" }, 500);
    }
    if (path === "/") return new Response(opts.sitePage ?? DEVNET_PAGE);
    if (path === "/api/coins") return json({ coins: opts.coins ?? [OTHER_COIN] });
    if (path.startsWith("/api/meta/")) return json({ name: "x", external_url: `${publicUrl}/coin/${path.slice(10)}` });
    if (path === `/api/coins/${mint}`) return opts.detail ? json({ coin: opts.detail }) : json({ error: "not found" }, 404);
    if (path === "/api/launch-fee") return json({ sol: "0" });
    if (path === "/api/tx/launch") {
      calls.launchBody = JSON.parse(init.body);
      if ((opts.takenAtBuild ?? []).includes(calls.launchBody.symbol)) return json({ error: `$${calls.launchBody.symbol} is taken. Pick another ticker` }, 400);
      const tx = opts.launchTx ?? fakeTx([kp.publicKey, mint, DEVNET_CONFIG]);
      return json({ transaction: Buffer.from(tx).toString("base64"), blockhash: "BH", intent: "I1", mint });
    }
    if (path.startsWith("/api/tx/status")) {
      // Like the real route: a cross-site Origin is refused.
      if (init.headers?.origin && init.headers.origin !== publicUrl) return json({ error: "Forbidden" }, 403);
      return json({ status: statuses.shift() ?? "confirmed" });
    }
    if (path === "/api/predictions/session") {
      const { message } = JSON.parse(init.body);
      // Like the real check: the message must name the server's own domain.
      if (!message.startsWith(`${new URL(publicUrl).host} wants you`)) return json({ error: "This sign-in was made for another site" }, 400);
      return json({ token: "T", expiresAt: NOW + 1e7, granted: 0 });
    }
    if (path === `/api/predictions/coin/${mint}`) {
      const staff = init.headers?.authorization === "Bearer T";
      if (method === "POST") {
        assert.ok(staff, "questions are posted signed in");
        const body = JSON.parse(init.body);
        if (game.pending) return json({ error: "A question is under review" }, 400);
        game.pending = { id: String(game.nextId++), text: body.text, stuck: false, polls: 0 };
        return json({ live: game.live, pending: game.pending });
      }
      if (game.pending && game.pending.polls++ >= 1) {
        const p = game.pending;
        game.pending = null;
        if (reject.has(p.text)) game.notice = "Your question wasn't approved: not visible on stream";
        else game.live.push({ id: p.id, text: p.text, lockAt: NOW + 5 * 60_000 });
      }
      return json({ live: game.live, resolved: game.resolved, pending: staff ? game.pending : null, me: staff ? { notice: game.notice } : null });
    }
    return json({ error: "not found" }, 404);
  }

  let clock = NOW;
  const logs = [];
  const env = { DAILY_SITE_URL: opts.redirectTo?.from ?? SITE, DAILY_RPC_URL: RPC, DAILY_STREAMER_KEY: secret, ...opts.env };
  const run = () => runDaily({ env, fetch: doFetch, now: () => clock, sleep: async (ms) => void (clock += ms), log: (l) => logs.push(l) });
  return { run, calls, logs, kp, mint, secret, game };
}

const launched = (w) => w.calls.site.includes("POST /api/tx/launch") || w.calls.sent > 0;
const noSecrets = (w) => {
  for (const line of w.logs) {
    assert.ok(!line.includes(w.secret), "the key is never logged");
    assert.ok(!line.includes("SECRETRPCKEY"), "the RPC URL's key is never logged");
  }
};
/** A coin this world's streamer launched today on `stream`. */
const todaysCoin = (w, stream) => ({ creator: w.kp.publicKey, symbol: `${stream.prefix}261022`, mint: w.mint, launchedAt: TODAY_S + 60, streamUrl: stream.url });

test("configFrom: https site origin and RPC, devnet-looking RPC, a valid key; errors never echo secrets", () => {
  const secret = newSecret();
  const ok = configFrom({ DAILY_SITE_URL: "https://www.memestream.lol/", DAILY_RPC_URL: "https://api.devnet.solana.com", DAILY_STREAMER_KEY: secret });
  assert.equal(ok.siteUrl, "https://www.memestream.lol");
  assert.equal(ok.dryRun, false);
  assert.equal(configFrom({ DAILY_SITE_URL: SITE, DAILY_RPC_URL: RPC, DAILY_STREAMER_KEY: secret, DAILY_DRY_RUN: "1" }).dryRun, true);
  const bad = [
    [{ DAILY_SITE_URL: "http://www.memestream.lol" }, /DAILY_SITE_URL/],
    [{ DAILY_SITE_URL: "https://www.memestream.lol/coin" }, /DAILY_SITE_URL/],
    [{ DAILY_SITE_URL: undefined }, /DAILY_SITE_URL/],
    [{ DAILY_RPC_URL: "http://api.devnet.solana.com" }, /DAILY_RPC_URL must be https/],
    [{ DAILY_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=SECRETRPCKEY" }, /names mainnet/],
    [{ DAILY_RPC_URL: "https://api.mainnet-beta.solana.com" }, /names mainnet/],
    [{ DAILY_STREAMER_KEY: undefined }, /Set DAILY_STREAMER_KEY/],
    [{ DAILY_STREAMER_KEY: secret.slice(0, 50) }, /base58 64-byte/],
  ];
  for (const [change, error] of bad) {
    const env = { DAILY_SITE_URL: SITE, DAILY_RPC_URL: "https://api.devnet.solana.com", DAILY_STREAMER_KEY: secret, ...change };
    assert.throws(() => configFrom(env), (e) => error.test(e.message) && !e.message.includes("SECRETRPCKEY") && !e.message.includes(secret.slice(0, 50)));
  }
});

test("siteNetwork / youtubeLive read the page's own flags", () => {
  assert.deepEqual(siteNetwork(DEVNET_PAGE), { chain: "solana:devnet", label: "Devnet" });
  assert.deepEqual(siteNetwork('<span class="net">Mainnet</span>{"chain":"solana:mainnet"}'), { chain: "solana:mainnet", label: "Mainnet" });
  assert.equal(siteNetwork(DEVNET_PAGE + "solana:mainnet").chain, "solana:mainnet", "any mainnet mention wins");
  assert.deepEqual(siteNetwork("<html>maintenance</html>"), { chain: null, label: null });
  assert.equal(youtubeLive(LIVE_PAGE), true);
  assert.equal(youtubeLive(`"isLiveNow":false`), false);
  assert.equal(youtubeLive(ENDED_PAGE), false);
  assert.equal(youtubeLive(CONSENT_PAGE), null);
});

test("launches today's live stream, then asks questions until 3 are live; a rejected one is skipped", async () => {
  const stream = rotation(NOW)[0];
  const w = world({ reject: [stream.questions[0]] });
  assert.equal(await w.run(), 0);
  assert.equal(w.calls.sent, 1);
  assert.deepEqual(w.calls.launchBody, { wallet: w.kp.publicKey, name: `${stream.label} · Oct 22`, symbol: `${stream.prefix}261022`, streamUrl: stream.url });
  assert.deepEqual(w.game.live.map((p) => p.text), stream.questions.slice(1, 4));
  // Every safety check ran before the launch was built.
  const launchAt = w.calls.site.indexOf("POST /api/tx/launch");
  for (const step of ["GET /", "GET /api/coins"]) assert.ok(w.calls.site.indexOf(step) < launchAt, step);
  assert.deepEqual(w.calls.rpc.slice(0, 3), ["getGenesisHash", "getSignaturesForAddress", "getBalance"]);
  assert.ok(w.logs.some((l) => /not approved/.test(l)));
  assert.ok(w.calls.youtube.every(([, redirect]) => redirect === "follow"), "the live check follows redirects (consent pages)");
  assert.match(w.logs.at(-1), /done: 3 questions/);
  noSecrets(w);
});

test("Origin and the sign-in domain are the server's public URL (from coin metadata), not DAILY_SITE_URL", async () => {
  const w = world({ publicUrl: "https://public.test" });
  assert.equal(await w.run(), 0);
  assert.ok(w.logs.some((l) => l.includes("the server's public URL is https://public.test, not https://site.test")));
  assert.ok(w.calls.signins.every((m) => m.startsWith("public.test wants you")));
  const after = w.calls.site.indexOf("GET /api/meta/" + OTHER_COIN.mint);
  assert.ok(w.calls.origins.slice(after + 1).every((o) => o === "https://public.test"));
  assert.equal(w.game.live.length, 3);
});

test("a DAILY_SITE_URL that redirects (apex to www) is followed, then checked as devnet there", async () => {
  const w = world({ redirectTo: { from: "https://apex.test" } });
  assert.equal(await w.run(), 0);
  assert.ok(w.logs.some((l) => l.includes("https://apex.test redirects to https://site.test")));
  assert.deepEqual(w.calls.site.slice(0, 2), ["redirect https://apex.test/", "GET /"]);
  assert.equal(w.game.live.length, 3);
});

test("SAFETY: a mainnet RPC (genesis hash) stops the run before any site call or transaction", async () => {
  const w = world({ genesis: MAINNET_GENESIS });
  assert.equal(await w.run(), 1);
  assert.equal(launched(w), false);
  assert.deepEqual(w.calls.site, []);
  assert.match(w.logs.at(-1), /not devnet's; stopping, no transaction/);
});

test("SAFETY: a site that says mainnet, or doesn't say devnet, stops the run with no transaction", async () => {
  const pages = ['<span class="net">Mainnet</span>{"chain":"solana:mainnet"}', '<span class="net">Devnet</span>', "", DEVNET_PAGE.replace("Devnet", "Mainnet")];
  for (const sitePage of pages) {
    const w = world({ sitePage });
    assert.equal(await w.run(), 1, sitePage);
    assert.equal(launched(w), false);
    assert.deepEqual(w.calls.site, ["GET /"]);
    assert.match(w.logs.at(-1), /not devnet; stopping, no transaction/);
  }
});

test("SAFETY: today's coin in the site list means no second launch; the run resumes its missing questions", async () => {
  const stream = rotation(NOW)[0];
  const probe = world();
  const w = world({ secret: probe.secret, mint: probe.mint, coins: [OTHER_COIN, todaysCoin(probe, stream)], game: { live: [{ id: "1", text: stream.questions[0], lockAt: NOW }], nextId: 2 } });
  assert.equal(await w.run(), 0);
  assert.equal(launched(w), false);
  assert.ok(w.logs.some((l) => /already launched .*resuming its questions, no second launch/.test(l)));
  assert.deepEqual(w.game.live.map((p) => p.text), stream.questions.slice(0, 3), "asks only the 2 missing, never the one already live");
});

test("resume: a question still under review is waited for and counted; a coin with 3 already asks nothing", async () => {
  const stream = rotation(NOW)[0];
  const probe = world();
  const coins = [todaysCoin(probe, stream)];
  const pending = world({ secret: probe.secret, mint: probe.mint, coins, game: { pending: { id: "1", text: stream.questions[2], stuck: false, polls: 0 }, nextId: 2 } });
  assert.equal(await pending.run(), 0);
  assert.deepEqual(pending.game.live.map((p) => p.text), [stream.questions[2], stream.questions[0], stream.questions[1]]);
  const full = world({ secret: probe.secret, mint: probe.mint, coins, game: { live: stream.questions.slice(0, 2).map((text, i) => ({ id: String(i), text, lockAt: NOW })), resolved: [{ id: "9", text: stream.questions[3] }] } });
  assert.equal(await full.run(), 0);
  assert.deepEqual(full.calls.signins, [], "nothing to ask: no sign-in");
  assert.ok(!full.calls.site.some((c) => c.startsWith("POST")));
});

test("SAFETY: a launch the chain shows today (coin hidden from the list) is resumed, never launched twice", async () => {
  const stream = rotation(NOW)[0];
  const probe = world();
  const sig = { signature: "S1", err: null, blockTime: NOW / 1000 - 600 };
  const w = world({ secret: probe.secret, mint: probe.mint, signatures: [sig], detail: todaysCoin(probe, stream) });
  assert.equal(await w.run(), 0);
  assert.equal(launched(w), false);
  assert.ok(w.calls.site.includes(`GET /api/coins/${probe.mint}`));
  assert.equal(w.game.live.length, 3);
  // A paid transaction whose coin can't be read: stop, never launch again.
  const unknown = world({ signatures: [sig] });
  assert.equal(await unknown.run(), 1);
  assert.equal(launched(unknown), false);
  assert.match(unknown.logs.at(-1), /can't be read; not launching again/);
  // A funding transfer (someone else paid), a failed one, or yesterday's: still launches.
  for (const signatures of [[{ ...sig, err: { x: 1 } }], [{ ...sig, blockTime: TODAY_S - 1 }], [{ ...sig, payer: "Funder1111111111111111111111111111111111111" }]]) {
    const x = world({ signatures });
    assert.equal(await x.run(), 0);
    assert.equal(launched(x), true);
  }
});

test("SAFETY: the today check pages back until yesterday, and stops if it can't get there", async () => {
  const funding = (i) => ({ signature: `F${i}`, err: null, blockTime: NOW / 1000 - i, payer: "Funder1111111111111111111111111111111111111" });
  const probe = world();
  const stream = rotation(NOW)[0];
  // 150 funding transfers today, then our launch: found on the second page.
  const deep = world({ secret: probe.secret, mint: probe.mint, detail: todaysCoin(probe, stream), signatures: [...Array.from({ length: 150 }, (_, i) => funding(i)), { signature: "L", err: null, blockTime: NOW / 1000 - 999 }] });
  assert.equal(await deep.run(), 0);
  assert.equal(launched(deep), false);
  assert.equal(deep.calls.rpc.filter((m) => m === "getSignaturesForAddress").length, 2);
  // More than the cap, all today: can't tell, so no launch.
  const flood = world({ signatures: Array.from({ length: MAX_SIGNATURE_SCAN + 50 }, (_, i) => funding(i)) });
  assert.equal(await flood.run(), 1);
  assert.equal(launched(flood), false);
  assert.match(flood.logs.at(-1), /can't tell if a coin launched; not launching/);
});

test("SAFETY: the site's launch transaction must be paid by the streamer and use the devnet config, else it is not signed", async () => {
  for (const make of [(kp, mint) => fakeTx([mint, kp.publicKey, DEVNET_CONFIG]), (kp, mint) => fakeTx([kp.publicKey, mint, "11111111111111111111111111111111"])]) {
    const secret = newSecret();
    const kp = keypairFromSecret(secret);
    const w = world({ secret, launchTx: make(kp, keypairFromSecret(newSecret()).publicKey) });
    assert.equal(await w.run(), 1);
    assert.equal(w.calls.sent, 0);
    assert.match(w.logs.at(-1), /not signing/);
  }
});

test("transient 5xx answers on the status poll, sign-in and question posts are retried", async () => {
  const stream = rotation(NOW)[0];
  const mint = keypairFromSecret(newSecret()).publicKey;
  const v = world({ mint, flaky: { "GET /api/tx/status": 2, "POST /api/predictions/session": 1, [`POST /api/predictions/coin/${mint}`]: 2 } });
  assert.equal(await v.run(), 0);
  assert.equal(v.calls.sent, 1);
  assert.equal(v.calls.signins.length, 2, "a new message (nonce) per sign-in try");
  assert.notEqual(v.calls.signins[0], v.calls.signins[1]);
  assert.deepEqual(v.game.live.map((p) => p.text), stream.questions.slice(0, 3));
});

test("an expired launch stops unless the chain shows it landed", async () => {
  const gone = world({ statuses: ["pending", "expired"] });
  assert.equal(await gone.run(), 1);
  assert.match(gone.logs.at(-1), /expired before it landed .*nothing launched/);
  const landed = world({ statuses: ["expired"], chainStatus: { err: null, confirmationStatus: "confirmed" } });
  assert.equal(await landed.run(), 0);
  assert.equal(landed.game.live.length, 3);
});

test("DAILY_DRY_RUN=1: every check, the plan printed, no launch build, no transaction, no sign-in", async () => {
  const w = world({ env: { DAILY_DRY_RUN: "1" } });
  assert.equal(await w.run(), 0);
  assert.equal(launched(w), false);
  assert.ok(!w.calls.site.some((c) => c.startsWith("POST")));
  assert.ok(w.logs.some((l) => /dry run: would launch ".* · Oct 22" \$\w+261022 on https:\/\/www\.youtube\.com/.test(l)));
  assert.match(w.logs.at(-1), /every check passed; no transaction sent/);
  const broke = world({ env: { DAILY_DRY_RUN: "1" }, balance: 0 });
  assert.equal(await broke.run(), 1);
  assert.equal(launched(broke), false);
  assert.match(broke.logs.at(-1), /would stop at the balance check/);
  noSecrets(w);
});

test("a low balance stops a real run before the launch", async () => {
  const w = world({ balance: 0.01 });
  assert.equal(await w.run(), 1);
  assert.equal(launched(w), false);
  assert.match(w.logs.at(-1), /balance: too low/);
});

test("live check: a stream that isn't live, or whose watch page can't tell, is skipped for the next", async () => {
  const [first, second, third] = rotation(NOW);
  const w = world({ liveKeys: [second.key], env: { DAILY_DRY_RUN: "1" } });
  assert.equal(await w.run(), 0);
  assert.ok(w.logs.some((l) => l.includes(`stream: ${first.key} is not live; skipped`)));
  assert.ok(w.logs.some((l) => l.includes(`would launch "${second.label}`)));
  const consent = world({ consentKeys: [first.key, second.key], env: { DAILY_DRY_RUN: "1" } });
  assert.equal(await consent.run(), 0);
  assert.ok(consent.logs.some((l) => l.includes(`stream: ${first.key} could not tell if live; skipped`)));
  assert.ok(consent.logs.some((l) => l.includes(`would launch "${third.label}`)));
  assert.deepEqual(consent.calls.thumbs, [], "no preview-picture fallback");
  const none = world({ liveKeys: [] });
  assert.equal(await none.run(), 1);
  assert.equal(launched(none), false);
  assert.match(none.logs.at(-1), /no live cam with a free ticker/);
});

test("a taken ticker (site list or at build) moves on to the next cam", async () => {
  const [first, second, third] = rotation(NOW);
  const w = world({ coins: [{ ...OTHER_COIN, symbol: `${first.prefix}261022` }], takenAtBuild: [`${second.prefix}261022`] });
  assert.equal(await w.run(), 0);
  assert.ok(w.logs.some((l) => l.includes(`$${first.prefix}261022 is taken; next cam`)));
  assert.ok(w.logs.some((l) => l.includes(`launch: $${second.prefix}261022 is taken; next cam`)));
  assert.equal(w.calls.launchBody.symbol, `${third.prefix}261022`);
  assert.equal(w.calls.sent, 1);
});

test("fewer than 2 questions approved ends the run non-zero (after the launch)", async () => {
  const stream = rotation(NOW)[0];
  const w = world({ reject: stream.questions.slice(0, -1) });
  assert.equal(await w.run(), 1);
  assert.equal(w.game.live.length, 1);
  assert.match(w.logs.at(-1), /done: 1 question live/);
});
