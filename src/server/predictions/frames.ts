/**
 * Still frames of a coin's stream for the AI check: the platform's public preview picture.
 * Only Twitch and YouTube have one; URLs are built from a validated login or video id on two
 * fixed hosts, never from a URL the user typed, and each fetch is time- and size-capped.
 */
import "server-only";
import { createHash } from "node:crypto";
import { parseStreamLink } from "@/lib/stream-link";

const TWITCH_LOGIN = /^[a-z0-9_]{3,25}$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const FRAME_HOSTS = new Set(["static-cdn.jtvnw.net", "i.ytimg.com"]);
const FETCH_TIMEOUT_MS = 5_000;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/** The preview URLs to try, best first; none for Kick, other hosts or a bad link. */
export function frameUrls(streamUrl: string | null | undefined): string[] {
  const link = parseStreamLink(streamUrl ?? "");
  if (!link) return [];
  const url = new URL(link.url);
  if (link.platform === "twitch") {
    const login = url.pathname.slice(1).toLowerCase();
    return TWITCH_LOGIN.test(login) ? [`https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-1280x720.jpg`] : [];
  }
  if (link.platform === "youtube") {
    const id = url.searchParams.get("v") ?? "";
    return YOUTUBE_ID.test(id) ? ["maxresdefault_live", "hqdefault_live"].map((name) => `https://i.ytimg.com/vi/${id}/${name}.jpg`) : [];
  }
  return [];
}

/**
 * `hash`: a short hash of the picture's bytes, so a picture the preview still shows isn't described
 * again. `shot`: when the CDN says the picture was made (its Last-Modified), if it says; a preview
 * can be minutes old when grabbed.
 */
export type Frame = { url: string; mime: string; base64: string; hash: string; shot?: number };
/** Hex characters of the picture's SHA-256 kept as its hash. */
export const HASH_CHARS = 16;
export type FrameDeps = { fetch?: typeof fetch; timeoutMs?: number };

/** The first preview that loads as an image (no redirects: an offline Twitch channel redirects to a placeholder), or null. */
export async function fetchFrame(urls: string[], deps: FrameDeps = {}): Promise<Frame | null> {
  for (const url of urls) {
    if (!FRAME_HOSTS.has(new URL(url).hostname) || !url.startsWith("https://")) continue;
    const frame = await fetchOne(url, deps).catch(() => null);
    if (frame) return frame;
  }
  return null;
}

async function fetchOne(url: string, deps: FrameDeps): Promise<Frame | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await (deps.fetch ?? fetch)(url, { redirect: "error", signal: abort.signal });
    const mime = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!response.ok || !/^image\/(jpeg|png|webp)$/.test(mime) || !response.body) return null;
    if (Number(response.headers.get("content-length") ?? 0) > MAX_FRAME_BYTES) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FRAME_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    if (size === 0) return null;
    const bytes = Buffer.concat(chunks);
    const shot = Date.parse(response.headers.get("last-modified") ?? "");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, HASH_CHARS);
    return { url, mime, base64: bytes.toString("base64"), hash, ...(Number.isFinite(shot) ? { shot } : {}) };
  } finally {
    clearTimeout(timer);
  }
}
