import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authorized, clampSeconds, createHandler, ffmpegArgs, grabClip, KILL_AFTER_MS, MAX_FRAMES, MAX_RESPONSE_BYTES, streamTarget, ytdlpArgs } from "./grab.mjs";

const SECRET = "s".repeat(40);
const LIVE = "https://www.youtube.com/watch?v=MW3fisTCXRQ";
const HLS = ["https://manifest.googlevideo.com/video.m3u8", "https://manifest.googlevideo.com/audio.m3u8"];

/**
 * A fake spawn: yt-dlp prints `urls`; ffmpeg writes `frames` JPEGs (of `frameBytes`) and an mp3 into
 * the dir in its args. `hang` never exits until killed. Records every call.
 */
function fakeSpawn({ urls = HLS, ytdlpCode = 0, ytdlpErr = "", frames = 3, frameBytes = 1_000, audio = true, ffmpegCode = 0, mute = false, hang = null, gate = null } = {}) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig) => ((child.killedWith = sig), setImmediate(() => child.emit("close", null)));
    if (hang === cmd) return child;
    setImmediate(async () => {
      if (gate) await gate;
      if (cmd === "yt-dlp") {
        child.stdout.emit("data", urls.join("\n") + "\n");
        if (ytdlpErr) child.stderr.emit("data", ytdlpErr);
        return child.emit("close", ytdlpCode);
      }
      // A mute stream: ffmpeg refuses an mp3 output with no stream, before writing anything.
      if (mute && args.at(-1).endsWith("audio.mp3")) {
        child.stderr.emit("data", "[out#1/mp3] Output file does not contain any stream\n");
        return child.emit("close", 234);
      }
      const dir = args.at(-1).replace(/\/(audio\.mp3|frame-%02d\.jpg)$/, "");
      for (let i = 1; i <= frames; i++) await writeFile(join(dir, `frame-${String(i).padStart(2, "0")}.jpg`), Buffer.alloc(frameBytes, i));
      if (audio && args.at(-1).endsWith("audio.mp3")) await writeFile(join(dir, "audio.mp3"), Buffer.alloc(500, 9));
      child.emit("close", ffmpegCode);
    });
    return child;
  };
  return { spawn, calls };
}

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "grab-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The handler on a real local server; returns a poster and the log lines. */
async function serve(t, options) {
  const lines = [];
  const server = createServer(createHandler({ secret: SECRET, log: (l) => lines.push(l), ...options }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, secret = SECRET) =>
    fetch(`${base}/clip`, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-grabber-secret": secret } : {}) }, body: JSON.stringify(body) });
  return { base, post, lines };
}

test("authorized: only the exact secret, and never when the server's secret is unset or short", () => {
  assert.equal(authorized(SECRET, SECRET), true);
  assert.equal(authorized(SECRET + "x", SECRET), false);
  assert.equal(authorized(undefined, SECRET), false);
  assert.equal(authorized("short", "short"), false);
  assert.equal(authorized(undefined, undefined), false);
});

test("streamTarget: https on the allowed hosts only, no user, password or port; logs host and id", () => {
  assert.deepEqual(streamTarget(LIVE), { url: LIVE, host: "www.youtube.com", id: "MW3fisTCXRQ" });
  assert.deepEqual(streamTarget("https://youtu.be/MW3fisTCXRQ"), { url: "https://youtu.be/MW3fisTCXRQ", host: "youtu.be", id: "MW3fisTCXRQ" });
  assert.equal(streamTarget("https://www.youtube.com/live/MW3fisTCXRQ").id, "MW3fisTCXRQ");
  assert.equal(streamTarget("https://twitch.tv/lofigirl").id, "lofigirl");
  assert.equal(streamTarget("https://kick.com/somebody").id, "somebody");
  for (const bad of [
    "http://www.youtube.com/watch?v=MW3fisTCXRQ",
    "https://m.youtube.com/watch?v=MW3fisTCXRQ",
    "https://youtube.com.evil.test/watch",
    "https://evil.test/?u=https://youtube.com",
    "https://user:pw@twitch.tv/lofigirl",
    "https://twitch.tv:8443/lofigirl",
    "https://169.254.169.254/latest",
    "file:///etc/passwd",
    "-o/tmp/x",
    "",
    42,
    undefined,
  ])
    assert.equal(streamTarget(bad), null, String(bad));
});

test("clampSeconds: whole seconds in 5..30, 15 when missing", () => {
  assert.deepEqual([clampSeconds(1), clampSeconds(5), clampSeconds(12.4), clampSeconds(30), clampSeconds(999), clampSeconds(undefined), clampSeconds("20"), clampSeconds(NaN)], [5, 5, 12, 30, 30, 15, 15, 15]);
});

test("ytdlpArgs and ffmpegArgs: the proven recipe, the link after --, near the live edge, one -t per output", () => {
  const y = ytdlpArgs(LIVE);
  assert.deepEqual(y.slice(-5), ["-g", "-f", "bv*[height<=720]+ba/b[height<=720]/b", "--", LIVE]);
  assert.ok(y.includes("--ignore-config") && !y.includes("--cookies"));
  assert.deepEqual(ytdlpArgs(LIVE, "/tmp/c/cookies.txt").slice(-7, -5), ["--cookies", "/tmp/c/cookies.txt"]);
  const two = ffmpegArgs(HLS, 20, "/tmp/d");
  assert.deepEqual(two.slice(5, 13), ["-live_start_index", "-4", "-i", HLS[0], "-live_start_index", "-4", "-i", HLS[1]]);
  assert.equal(two.filter((a) => a === "-t").length, 2);
  assert.deepEqual(two.slice(two.indexOf("-vf"), two.indexOf("-vf") + 4), ["-vf", "fps=1/5,scale=1280:-2", "-frames:v", String(MAX_FRAMES)]);
  assert.equal(two[two.lastIndexOf("-map") + 1], "1:a:0?", "audio from the audio input, if any");
  assert.deepEqual(two.slice(-7), ["-ac", "1", "-ar", "16000", "-b:a", "32k", "/tmp/d/audio.mp3"]);
  const one = ffmpegArgs([HLS[0]], 10, "/tmp/d");
  assert.equal(one.filter((a) => a === "-i").length, 1);
  assert.equal(one[one.lastIndexOf("-map") + 1], "0:a:0?", "audio from the only input, if it has any");
  const mute = ffmpegArgs([HLS[0]], 10, "/tmp/d", false);
  assert.deepEqual([mute.filter((a) => a === "-map").length, mute.at(-1), mute.includes("audio.mp3")], [1, "/tmp/d/frame-%02d.jpg", false], "frames only");
});

test("grabClip: a stream with no audio still gives frames, with audio null", async (t) => {
  const tmp = await tempRoot(t);
  const fake = fakeSpawn({ urls: [HLS[0]], mute: true });
  const clip = await grabClip(streamTarget("https://kick.com/somebody"), 10, { spawn: fake.spawn, tmp });
  assert.deepEqual([clip.frames.length, clip.audio], [3, null]);
  assert.deepEqual(fake.calls.map((c) => [c.cmd, c.args.at(-1).split("/").at(-1)]), [["yt-dlp", "somebody"], ["ffmpeg", "audio.mp3"], ["ffmpeg", "frame-%02d.jpg"]]);
  assert.deepEqual(await readdir(tmp), []);
  await assert.rejects(grabClip(streamTarget(LIVE), 10, { spawn: fakeSpawn({ ffmpegCode: 1 }).spawn, tmp }), /ffmpeg failed/, "other failures are not retried");
});

test("grabClip: frames and audio from a fake spawn, cookies written to the temp dir, the temp dir always removed", async (t) => {
  const tmp = await tempRoot(t);
  const fake = fakeSpawn();
  let clock = 1_000;
  const clip = await grabClip(streamTarget(LIVE), 20, { spawn: fake.spawn, tmp, now: () => (clock += 10), cookiesB64: Buffer.from("# cookies").toString("base64") });
  assert.equal(clip.frames.length, 3);
  assert.deepEqual(clip.frames[0], { mime: "image/jpeg", base64: Buffer.alloc(1_000, 1).toString("base64") });
  assert.equal(clip.audio.format, "mp3");
  assert.ok(clip.endedAt > clip.startedAt);
  assert.deepEqual(fake.calls.map((c) => c.cmd), ["yt-dlp", "ffmpeg"]);
  assert.equal(fake.calls[0].args[fake.calls[0].args.indexOf("--cookies") + 1].startsWith(tmp), true);
  assert.deepEqual(fake.calls[1].args.filter((a) => HLS.includes(a)), HLS);
  assert.deepEqual(await readdir(tmp), [], "temp dir removed after a good clip");

  await assert.rejects(grabClip(streamTarget(LIVE), 20, { spawn: fakeSpawn({ ffmpegCode: 1 }).spawn, tmp }), /ffmpeg failed/);
  await assert.rejects(grabClip(streamTarget(LIVE), 20, { spawn: fakeSpawn({ ytdlpCode: 1, urls: [], ytdlpErr: "ERROR: Sign in to confirm you're not a bot" }).spawn, tmp }), /bot check/);
  await assert.rejects(grabClip(streamTarget(LIVE), 20, { spawn: fakeSpawn({ urls: ["file:///etc/passwd"] }).spawn, tmp }), /unexpected/);
  await assert.rejects(grabClip(streamTarget(LIVE), 20, { spawn: fakeSpawn({ frames: 0 }).spawn, tmp }), /no frames/);
  assert.deepEqual(await readdir(tmp), [], "temp dir removed after failures too");
});

test("grabClip: a child that hangs is killed at seconds + 40 s", async (t) => {
  const tmp = await tempRoot(t);
  const fake = fakeSpawn({ hang: "ffmpeg" });
  let clock = 0;
  // The fake clock jumps past the deadline before ffmpeg starts, so its timer fires at once.
  const now = () => (clock += 5 * 1000 + KILL_AFTER_MS);
  await assert.rejects(grabClip(streamTarget(LIVE), 5, { spawn: fake.spawn, tmp, now }), /ffmpeg timed out/);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(await readdir(tmp), []);
});

test("grabClip: over the size cap, the oldest frames go first, then the audio", async (t) => {
  const tmp = await tempRoot(t);
  const big = Math.floor((MAX_RESPONSE_BYTES * 3) / 4 / 3);
  const clip = await grabClip(streamTarget(LIVE), 30, { spawn: fakeSpawn({ frames: 6, frameBytes: big }).spawn, tmp });
  assert.equal(clip.frames.length, 2);
  assert.equal(clip.frames.at(-1).base64, Buffer.alloc(big, 6).toString("base64"), "the newest frame is kept");
  assert.ok(clip.audio);
  const huge = await grabClip(streamTarget(LIVE), 30, { spawn: fakeSpawn({ frames: 2, frameBytes: Math.floor((MAX_RESPONSE_BYTES * 3) / 4) - 100 }).spawn, tmp });
  assert.deepEqual([huge.frames.length, huge.audio], [1, null]);
});

test("handler: health, 401 without the secret (and with no usable server secret), 400 for a bad link, 200 with the clip, logs without secrets or HLS URLs", async (t) => {
  const tmp = await tempRoot(t);
  const { base, post, lines } = await serve(t, { spawn: fakeSpawn().spawn, tmp });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await post({ url: LIVE }, null)).status, 401);
  assert.equal((await post({ url: LIVE }, "x".repeat(40))).status, 401);
  assert.equal((await post({ url: "https://evil.test/live" })).status, 400);
  const good = await post({ url: LIVE, seconds: 99 });
  assert.equal(good.status, 200);
  const clip = await good.json();
  assert.equal(clip.frames.length, 3);
  assert.equal(typeof clip.startedAt, "number");
  assert.ok(lines.some((l) => /^clip ok www\.youtube\.com MW3fisTCXRQ 30s frames=3 /.test(l)), lines.join("\n"));
  assert.ok(lines.every((l) => !l.includes(SECRET) && !l.includes("googlevideo")));

  const closed = await serve(t, { secret: "short", spawn: fakeSpawn().spawn, tmp });
  assert.equal((await closed.post({ url: LIVE }, "short")).status, 401, "a short server secret refuses all");
});

test("handler: a third clip while two run gets 429; the slots free up after", async (t) => {
  const tmp = await tempRoot(t);
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const { post } = await serve(t, { spawn: fakeSpawn({ gate }).spawn, tmp });
  const first = post({ url: LIVE });
  const second = post({ url: LIVE });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await post({ url: LIVE })).status, 429);
  open();
  assert.deepEqual([(await first).status, (await second).status], [200, 200]);
  assert.equal((await post({ url: LIVE })).status, 200);
  assert.deepEqual(await readdir(tmp), []);
});
