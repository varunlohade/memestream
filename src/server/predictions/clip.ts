/**
 * Short video clips of a coin's stream for the AI check, from the video grabber (grabber/, a Railway
 * service): the last few seconds as a few JPEG frames and a small mp3. Only a validated stream link
 * is sent, to one https grabber set in the environment, with its shared secret; the answer is time-
 * and size-capped and checked strictly. Any failure is null, so the caller falls back to the preview.
 */
import "server-only";
import { createHash } from "node:crypto";
import { parseStreamLink } from "@/lib/stream-link";
import { HASH_CHARS } from "./frames";

/** Seconds of stream per clip: a 10 s clip takes the grabber about 16 s. */
export const CLIP_SECONDS = 10;
/** The wait for a clip past its seconds: with the description, an AI run fits the routes' 120 s maxDuration. */
const CLIP_EXTRA_MS = 35_000;
/** The grabber keeps its answer under about 4 MB of base64; this allows for the JSON around it. */
export const MAX_CLIP_BYTES = 5 * 1024 * 1024;
const MAX_CLIP_FRAMES = 6;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type ClipFrame = { mime: "image/jpeg"; base64: string };
export type ClipAudio = { format: "mp3"; base64: string };
/** `hash`: a short hash of the frames' and audio's bytes. `startedAt`: when the grabber began the cut (its clock). */
export type Clip = { frames: ClipFrame[]; audio: ClipAudio | null; startedAt: number; hash: string };
export type ClipDeps = { url: string; secret: string; fetch?: typeof fetch; timeoutMs?: number; seconds?: number };
/** A clip of the stream now, or null (no grabber answer, or a bad one). */
export type ClipSource = (streamUrl: string) => Promise<Clip | null>;

const isBase64 = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length % 4 === 0 && BASE64.test(value);

/** The grabber's answer, checked field by field, with its hash; null if anything is off. */
export function parseClip(body: unknown): Clip | null {
  const { frames, audio, startedAt } = (body ?? {}) as { frames?: unknown; audio?: unknown; startedAt?: unknown };
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_CLIP_FRAMES) return null;
  if (!frames.every((f) => f?.mime === "image/jpeg" && isBase64(f?.base64))) return null;
  if (audio !== null && !((audio as ClipAudio)?.format === "mp3" && isBase64((audio as ClipAudio)?.base64))) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) return null;
  const hash = createHash("sha256");
  for (const f of frames as ClipFrame[]) hash.update(Buffer.from(f.base64, "base64"));
  if (audio) hash.update(Buffer.from((audio as ClipAudio).base64, "base64"));
  return {
    frames: (frames as ClipFrame[]).map(({ base64 }) => ({ mime: "image/jpeg", base64 })),
    audio: audio ? { format: "mp3", base64: (audio as ClipAudio).base64 } : null,
    startedAt,
    hash: hash.digest("hex").slice(0, HASH_CHARS),
  };
}

/** Reads the body up to `max` bytes; null when it is over. */
async function readCapped(response: Response, max: number): Promise<string | null> {
  if (Number(response.headers.get("content-length") ?? 0) > max || !response.body) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function clipClient(deps: ClipDeps): ClipSource {
  const seconds = deps.seconds ?? CLIP_SECONDS;
  return async (streamUrl) => {
    const link = parseStreamLink(streamUrl);
    if (!link) return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? seconds * 1000 + CLIP_EXTRA_MS);
    try {
      const response = await (deps.fetch ?? fetch)(deps.url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", "x-grabber-secret": deps.secret },
        body: JSON.stringify({ url: link.url, seconds }),
        signal: abort.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        console.warn(`predictions: the video grabber answered HTTP ${response.status}`);
        return null;
      }
      const text = await readCapped(response, MAX_CLIP_BYTES);
      const clip = text === null ? null : parseClip(JSON.parse(text));
      if (!clip) console.warn("predictions: the video grabber's answer was too big or malformed");
      return clip;
    } catch {
      console.warn(`predictions: the video grabber ${abort.signal.aborted ? "timed out" : "failed"}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The grabber from the environment (MEMESTREAM_GRABBER_URL, https; MEMESTREAM_GRABBER_SECRET, 32+ characters), or null. */
export function clipFromEnv(): ClipSource | null {
  const { MEMESTREAM_GRABBER_URL, MEMESTREAM_GRABBER_SECRET } = process.env;
  if (!MEMESTREAM_GRABBER_URL || !MEMESTREAM_GRABBER_SECRET) return null;
  let url: URL;
  try {
    url = new URL("/clip", MEMESTREAM_GRABBER_URL);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || MEMESTREAM_GRABBER_SECRET.length < 32) {
    console.warn("predictions: MEMESTREAM_GRABBER_URL must be https and MEMESTREAM_GRABBER_SECRET 32+ characters; clips are off");
    return null;
  }
  return clipClient({ url: url.href, secret: MEMESTREAM_GRABBER_SECRET });
}
