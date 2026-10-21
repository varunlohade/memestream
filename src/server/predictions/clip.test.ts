import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CLIP_SECONDS, clipClient, clipFromEnv, MAX_CLIP_BYTES, parseClip } from "./clip";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const GOOD = { frames: [{ mime: "image/jpeg", base64: "AAEC" }], audio: { format: "mp3", base64: "AAAA" }, startedAt: 1_760_000_000_000, endedAt: 1_760_000_010_000 };
const URL_ = "https://grabber.test/clip";
const SECRET = "g".repeat(32);

test("parseClip: the grabber's answer checked strictly; hash = sha256 of the frames' and audio's bytes", () => {
  const clip = parseClip(GOOD)!;
  const expected = createHash("sha256").update(Buffer.from("AAEC", "base64")).update(Buffer.from("AAAA", "base64")).digest("hex").slice(0, 16);
  assert.deepEqual(clip, { frames: GOOD.frames, audio: GOOD.audio, hash: expected }, "no time: a clip proves nothing about the lock");
  assert.equal(parseClip({ ...GOOD, audio: null })!.audio, null);
  for (const bad of [
    null,
    {},
    { ...GOOD, frames: [] },
    { ...GOOD, frames: Array(7).fill(GOOD.frames[0]) },
    { ...GOOD, frames: [{ mime: "image/png", base64: "AAEC" }] },
    { ...GOOD, frames: [{ mime: "image/jpeg", base64: "not base64!" }] },
    { ...GOOD, audio: { format: "wav", base64: "AAAA" } },
    { ...GOOD, audio: undefined },
    { ...GOOD, startedAt: "now" },
  ])
    assert.equal(parseClip(bad), null, JSON.stringify(bad));
});

test("clipClient: posts the normalized link, the seconds and the secret, no redirects; any failure says why, never a URL", async () => {
  const inits: RequestInit[] = [];
  const client = (answer: () => Response | Promise<Response>) => clipClient({ url: URL_, secret: SECRET, fetch: async (url, init) => (assert.equal(String(url), URL_), inits.push(init!), answer()) });
  assert.ok("frames" in (await client(() => json(GOOD))("https://www.twitch.tv/LofiGirl")));
  assert.deepEqual(JSON.parse(String(inits[0].body)), { url: "https://twitch.tv/LofiGirl", seconds: CLIP_SECONDS });
  assert.deepEqual([(inits[0].headers as Record<string, string>)["x-grabber-secret"], inits[0].redirect], [SECRET, "error"]);
  assert.deepEqual(await client(() => json(GOOD))("https://evil.test/live"), { failed: "bad link" });
  assert.equal(inits.length, 1, "a bad stream link is never sent");
  assert.deepEqual(await client(() => json({ error: "busy" }, 429))("https://kick.com/somebody"), { failed: "HTTP 429" });
  assert.deepEqual(await client(() => json({ ...GOOD, frames: "x" }))("https://kick.com/somebody"), { failed: "malformed" });
  assert.deepEqual(await client(() => new Response("not json"))("https://kick.com/somebody"), { failed: "malformed" });
  assert.deepEqual(await client(() => json({ ...GOOD, pad: "x".repeat(MAX_CLIP_BYTES) }))("https://kick.com/somebody"), { failed: "too big" });
  assert.deepEqual(await client(() => Promise.reject(new TypeError("down")))("https://kick.com/somebody"), { failed: "error" });
  const hang: typeof fetch = (_u, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  assert.deepEqual(await clipClient({ url: URL_, secret: SECRET, fetch: hang, timeoutMs: 20 })("https://kick.com/somebody"), { failed: "timeout" });
});

test("clipFromEnv: only an https grabber with a 32+ character secret", (t) => {
  const saved = { url: process.env.MEMESTREAM_GRABBER_URL, secret: process.env.MEMESTREAM_GRABBER_SECRET };
  t.after(() => {
    for (const [k, v] of [["MEMESTREAM_GRABBER_URL", saved.url], ["MEMESTREAM_GRABBER_SECRET", saved.secret]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const env = (url?: string, secret?: string) => {
    if (url === undefined) delete process.env.MEMESTREAM_GRABBER_URL; else process.env.MEMESTREAM_GRABBER_URL = url;
    if (secret === undefined) delete process.env.MEMESTREAM_GRABBER_SECRET; else process.env.MEMESTREAM_GRABBER_SECRET = secret;
    return clipFromEnv();
  };
  assert.equal(env(), null);
  assert.equal(env("https://grabber.test", undefined), null);
  assert.equal(env("http://grabber.test", SECRET), null);
  assert.equal(env("https://grabber.test", "short"), null);
  assert.equal(typeof env("https://grabber.test", SECRET), "function");
});
