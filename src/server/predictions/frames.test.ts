import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fetchFrame, frameUrls, MAX_FRAME_BYTES } from "./frames";

const jpeg = (bytes = 10, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(bytes).fill(7), { status: 200, headers: { "content-type": "image/jpeg", ...headers } });

test("frameUrls: Twitch by lowercased login; YouTube maxres then hq live previews", () => {
  assert.deepEqual(frameUrls("https://twitch.tv/LofiGirl"), ["https://static-cdn.jtvnw.net/previews-ttv/live_user_lofigirl-1280x720.jpg"]);
  assert.deepEqual(frameUrls("https://www.youtube.com/watch?v=jfKfPfyJRdk"), [
    "https://i.ytimg.com/vi/jfKfPfyJRdk/maxresdefault_live.jpg",
    "https://i.ytimg.com/vi/jfKfPfyJRdk/hqdefault_live.jpg",
  ]);
  assert.deepEqual(frameUrls("https://youtu.be/jfKfPfyJRdk"), frameUrls("https://www.youtube.com/watch?v=jfKfPfyJRdk"));
});

test("frameUrls: no frames for Kick, other hosts, bad ids or logins, or no link", () => {
  for (const url of [
    "https://kick.com/somebody",
    "https://evil.example/live_user_x.jpg",
    "https://static-cdn.jtvnw.net/previews-ttv/live_user_x-1280x720.jpg",
    "http://twitch.tv/lofigirl",
    "https://twitch.tv/lofi%2F..%2Fx",
    "https://twitch.tv/directory",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=jfKfPfyJRdk/../x",
    "",
    null,
    undefined,
  ]) {
    assert.deepEqual(frameUrls(url), [], String(url));
  }
});

test("fetchFrame: refuses hosts other than the two preview CDNs without fetching", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => (calls++, jpeg());
  assert.equal(await fetchFrame(["https://evil.example/a.jpg", "http://i.ytimg.com/vi/x/a.jpg", "https://169.254.169.254/latest"], { fetch }), null);
  assert.equal(calls, 0);
});

test("fetchFrame: the first preview that loads, no redirects; a 404 falls through to the next", async () => {
  const seen: { url: string; redirect?: RequestRedirect }[] = [];
  const urls = frameUrls("https://www.youtube.com/watch?v=jfKfPfyJRdk");
  const fetch: typeof globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), redirect: init?.redirect });
    return String(url).includes("maxres") ? new Response("nope", { status: 404, headers: { "content-type": "image/jpeg" } }) : jpeg(3);
  };
  const frame = await fetchFrame(urls, { fetch });
  const hash = createHash("sha256").update(Buffer.from([7, 7, 7])).digest("hex").slice(0, 16);
  assert.deepEqual(frame, { url: urls[1], mime: "image/jpeg", base64: Buffer.from([7, 7, 7]).toString("base64"), hash });
  assert.deepEqual(seen.map((s) => s.redirect), ["error", "error"]);
});

test("fetchFrame: not an image, too big, a redirect or a timeout is no frame", async () => {
  const urls = frameUrls("https://twitch.tv/lofigirl");
  const html: typeof fetch = async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
  assert.equal(await fetchFrame(urls, { fetch: html }), null);
  const saysBig: typeof fetch = async () => jpeg(10, { "content-length": String(MAX_FRAME_BYTES + 1) });
  assert.equal(await fetchFrame(urls, { fetch: saysBig }), null);
  const isBig: typeof fetch = async () => jpeg(MAX_FRAME_BYTES + 1);
  assert.equal(await fetchFrame(urls, { fetch: isBig }), null);
  const redirected: typeof fetch = async () => Promise.reject(new TypeError("redirect mode is set to error"));
  assert.equal(await fetchFrame(urls, { fetch: redirected }), null);
  const hang: typeof fetch = (_url, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  assert.equal(await fetchFrame(urls, { fetch: hang, timeoutMs: 20 }), null);
});
