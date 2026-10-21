/**
 * The video grabber: POST /clip cuts the last few seconds of a live stream into a few JPEG frames and
 * a small mono mp3, for the site's AI referee. yt-dlp finds the stream's HLS URLs (YouTube gives a
 * video and an audio one, Twitch and Kick one with both), then ffmpeg reads from near the live edge.
 * Only https links on a fixed list of stream sites are taken (no SSRF), the caller needs the shared
 * secret, at most MAX_RUNNING clips run at once, each child process is killed at a hard deadline (or
 * as soon as the caller hangs up), and every request's temp dir is removed. Logs one line per request: outcome, reason, host and video
 * id or channel, never the secret or an HLS URL.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ALLOWED_HOSTS = new Set(["youtube.com", "www.youtube.com", "youtu.be", "twitch.tv", "www.twitch.tv", "kick.com"]);
export const MIN_SECRET_CHARS = 32;
export const MIN_SECONDS = 5;
export const MAX_SECONDS = 30;
export const DEFAULT_SECONDS = 15;
/** Each request's children are killed this long after the clip's own seconds: before the site gives up (seconds + 35 s). */
export const KILL_AFTER_MS = 30_000;
export const MAX_FRAMES = 6;
/** Clips at once by default (GRABBER_MAX_RUNNING). */
export const MAX_RUNNING = 4;
/** The response's frames and audio together (base64), about 4 MB; frames go first when over. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 2_048;
/** HLS segments back from the live edge where reading starts, so the clip ends near now. */
const LIVE_START_INDEX = "-4";
const STDERR_TAIL_CHARS = 2_000;

/** The secret is usable: set and at least MIN_SECRET_CHARS long. */
export const secretUsable = (secret) => typeof secret === "string" && secret.length >= MIN_SECRET_CHARS;

/** Constant-time: both sides are hashed first, so lengths never leak either. False without a usable secret. */
export function authorized(given, secret) {
  if (!secretUsable(secret) || typeof given !== "string") return false;
  const digest = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

/** The clip's length: whole seconds in MIN_SECONDS..MAX_SECONDS; DEFAULT_SECONDS when missing or not a number. */
export function clampSeconds(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

/**
 * The stream link, if it is a plain https link on an allowed host (no user, password or port), with
 * what the log may show: the host and the video id or channel name. Null otherwise.
 */
export function streamTarget(raw) {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !ALLOWED_HOSTS.has(url.hostname)) return null;
  const segment = url.pathname.split("/").filter(Boolean);
  const id = url.searchParams.get("v") ?? (url.hostname === "youtu.be" || !url.hostname.includes("youtube") ? segment[0] : segment[1]) ?? "";
  return { url: url.href, host: url.hostname, id: id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30) };
}

/** yt-dlp's arguments: print the HLS URL(s) of the best stream up to 720p (video then audio, or one with both). */
export function ytdlpArgs(url, cookiesPath = null) {
  return [
    "--ignore-config",
    "--no-playlist",
    "--no-warnings",
    "--js-runtimes",
    "node",
    ...(cookiesPath ? ["--cookies", cookiesPath] : []),
    "-g",
    "-f",
    "bv*[height<=720]+ba/b[height<=720]/b",
    "--",
    url,
  ];
}

/**
 * ffmpeg's arguments: each input read from LIVE_START_INDEX segments back; `seconds` of it as a JPEG
 * every 5 s (1280 wide, at most MAX_FRAMES) from the video, and (with `audio`) as a 16 kHz mono mp3
 * from the audio: the second input, or the only one's audio if it has any.
 */
export function ffmpegArgs(inputs, seconds, dir, audio = true) {
  const audioInput = inputs.length > 1 ? 1 : 0;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    ...inputs.flatMap((input) => ["-live_start_index", LIVE_START_INDEX, "-i", input]),
    "-map",
    "0:v:0",
    "-t",
    String(seconds),
    "-vf",
    "fps=1/5,scale=1280:-2",
    "-frames:v",
    String(MAX_FRAMES),
    "-q:v",
    "4",
    join(dir, "frame-%02d.jpg"),
    ...(audio ? ["-map", `${audioInput}:a:0?`, "-t", String(seconds), "-ac", "1", "-ar", "16000", "-b:a", "32k", join(dir, "audio.mp3")] : []),
  ];
}

/** ffmpeg's answer when the optional audio map found no audio: the mp3 output has nothing in it. */
const NO_AUDIO = /does not contain any stream/i;

/** A failed clip, with a short reason for the log and the answer (never a URL or the tool's whole output). */
export class GrabFailed extends Error {}

/**
 * Runs `cmd` (args array, never a shell); killed at `timeoutMs`, or when `signal` aborts (the caller
 * hung up). Resolves with its exit code, stdout and the tail of stderr.
 */
export function run(spawn, cmd, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GrabFailed("caller gone"));
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = null;
    const kill = (why) => {
      killed ??= why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill(`${cmd} timed out`), Math.max(0, timeoutMs));
    const hangUp = () => kill("caller gone");
    signal?.addEventListener("abort", hangUp, { once: true });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-STDERR_TAIL_CHARS)));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", hangUp);
    };
    child.on("error", (error) => {
      done();
      reject(new GrabFailed(`${cmd} could not start (${error.code ?? "error"})`));
    });
    child.on("close", (code) => {
      done();
      if (killed) reject(new GrabFailed(killed));
      else resolve({ code, stdout, stderr });
    });
  });
}

/** Why yt-dlp found no stream, in a few words. */
function ytdlpReason(stderr) {
  if (/confirm you.re not a bot|sign in to confirm/i.test(stderr)) return "youtube bot check (cookies needed)";
  if (/offline|not currently live|has ended|will begin|premieres in/i.test(stderr)) return "stream not live";
  return "yt-dlp found no stream";
}

/**
 * One clip: the stream's HLS URLs from yt-dlp, then ffmpeg, both under one deadline, in a temp dir
 * that is always removed. Frames newest-kept when over MAX_RESPONSE_BYTES, then the audio is dropped.
 */
export async function grabClip(target, seconds, deps) {
  const { spawn = nodeSpawn, now = Date.now, ytdlp = "yt-dlp", ffmpeg = "ffmpeg", tmp = tmpdir(), cookiesB64 = null, signal } = deps;
  const deadline = now() + seconds * 1000 + KILL_AFTER_MS;
  const dir = await mkdtemp(join(tmp, "clip-"));
  try {
    let cookiesPath = null;
    if (cookiesB64) {
      cookiesPath = join(dir, "cookies.txt");
      await writeFile(cookiesPath, Buffer.from(cookiesB64, "base64"), { mode: 0o600 });
    }
    const found = await run(spawn, ytdlp, ytdlpArgs(target.url, cookiesPath), deadline - now(), signal);
    const inputs = found.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (found.code !== 0 || inputs.length === 0) throw new GrabFailed(ytdlpReason(found.stderr));
    if (inputs.length > 2 || !inputs.every((input) => input.startsWith("https://"))) throw new GrabFailed("yt-dlp gave unexpected URLs");
    let startedAt = now();
    let cut = await run(spawn, ffmpeg, ffmpegArgs(inputs, seconds, dir), deadline - now(), signal);
    // A stream with no audio: ffmpeg stops at once (the mp3 has no stream), so cut the frames alone.
    if (cut.code !== 0 && NO_AUDIO.test(cut.stderr)) {
      startedAt = now();
      cut = await run(spawn, ffmpeg, ffmpegArgs(inputs, seconds, dir, false), deadline - now(), signal);
    }
    const endedAt = now();
    if (cut.code !== 0) throw new GrabFailed("ffmpeg failed");
    const names = (await readdir(dir)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
    const frames = [];
    for (const name of names.slice(0, MAX_FRAMES)) frames.push({ mime: "image/jpeg", base64: (await readFile(join(dir, name))).toString("base64") });
    if (frames.length === 0) throw new GrabFailed("no frames");
    const mp3 = await readFile(join(dir, "audio.mp3")).catch(() => null);
    let audio = mp3 && mp3.length > 0 ? { format: "mp3", base64: mp3.toString("base64") } : null;
    const size = () => frames.reduce((sum, f) => sum + f.base64.length, 0) + (audio?.base64.length ?? 0);
    while (size() > MAX_RESPONSE_BYTES && frames.length > 1) frames.shift();
    if (size() > MAX_RESPONSE_BYTES) audio = null;
    if (size() > MAX_RESPONSE_BYTES) throw new GrabFailed("clip too large");
    return { frames, audio, startedAt, endedAt };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Reads a small JSON body; null when it is too big or not JSON. */
async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * The HTTP handler: GET /health, and POST /clip with the secret in x-grabber-secret. Answers 401
 * without the right secret (always, when the server's secret is unset or short), 400 for a bad link,
 * 429 when MAX_RUNNING clips are running, 502 when the grab failed.
 */
export function createHandler({ secret, log = console.log, maxRunning = MAX_RUNNING, ...deps }) {
  let running = 0;
  const send = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  return async (request, response) => {
    const path = new URL(request.url ?? "/", "http://grabber").pathname;
    if (request.method === "GET" && path === "/health") return send(response, 200, { ok: true });
    if (request.method !== "POST" || path !== "/clip") return send(response, 404, { error: "not found" });
    if (!authorized(request.headers["x-grabber-secret"], secret)) {
      log("clip refused (unauthorized)");
      return send(response, 401, { error: "unauthorized" });
    }
    if (running >= maxRunning) {
      log("clip refused (busy)");
      return send(response, 429, { error: "busy" });
    }
    running++;
    const started = Date.now();
    let where = "";
    // The caller hung up before the answer: stop the tools now, so the slot frees at once.
    const hangUp = new AbortController();
    response.on("close", () => response.writableFinished || hangUp.abort());
    try {
      const body = await readJson(request);
      const target = streamTarget(body?.url);
      if (!target) {
        log("clip refused (bad link)");
        return send(response, 400, { error: "bad link" });
      }
      where = `${target.host} ${target.id || "-"}`;
      const seconds = clampSeconds(body.seconds);
      const clip = await grabClip(target, seconds, { ...deps, signal: hangUp.signal });
      const audioKb = clip.audio ? Math.round((clip.audio.base64.length * 3) / 4 / 1024) : 0;
      log(`clip ok ${where} ${seconds}s frames=${clip.frames.length} audio=${audioKb}KB ${Date.now() - started}ms`);
      return send(response, 200, clip);
    } catch (error) {
      const reason = error instanceof GrabFailed ? error.message : "internal error";
      log(`clip failed (${reason}) ${where} ${Date.now() - started}ms`);
      return send(response, 502, { error: reason });
    } finally {
      running--;
    }
  };
}
