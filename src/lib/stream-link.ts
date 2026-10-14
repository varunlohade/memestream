/**
 * Stream links (Twitch, YouTube, Kick): validation, embed URLs, and how a link is stored.
 * The link rides in the coin's metadata URI as a query param, so no database is needed.
 */

export type StreamPlatform = "twitch" | "youtube" | "kick";
export type StreamLink = {
  platform: StreamPlatform;
  url: string;
  /** YouTube's 11-character video ID; null on other platforms. */
  videoId: string | null;
  embedUrl: (parentHost: string) => string;
  /** A still picture of the stream (YouTube and Twitch), for tiles and the coin icon. */
  thumbnailUrl: string | null;
};

const TWITCH_CHANNEL = /^\/([a-zA-Z0-9_]{3,25})\/?$/;
/** Twitch site pages that look like channel names. */
const TWITCH_RESERVED = new Set(["directory", "videos", "settings", "subscriptions", "inventory", "wallet", "search", "downloads", "jobs", "p", "login", "signup"]);
const KICK_CHANNEL = /^\/([a-zA-Z0-9_-]{2,30})\/?$/;
const YOUTUBE_ID = /^[a-zA-Z0-9_-]{11}$/;

function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.replace(/^www\.|^m\./, "");
  const id =
    host === "youtu.be"
      ? url.pathname.slice(1)
      : url.pathname === "/watch"
        ? url.searchParams.get("v")
        : url.pathname.match(/^\/(?:live|embed|shorts)\/([^/]+)/)?.[1];
  return id && YOUTUBE_ID.test(id) ? id : null;
}

/** Returns null for anything that isn't a plain https Twitch channel, YouTube video/live, or Kick channel. */
export function parseStreamLink(raw: string): StreamLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\.|^m\./, "");

  if (host === "twitch.tv") {
    const channel = url.pathname.match(TWITCH_CHANNEL)?.[1];
    if (!channel || TWITCH_RESERVED.has(channel.toLowerCase())) return null;
    return {
      platform: "twitch",
      url: `https://twitch.tv/${channel}`,
      videoId: null,
      embedUrl: (parent) =>
        `https://player.twitch.tv/?channel=${channel}&parent=${encodeURIComponent(parent)}&muted=true`,
      thumbnailUrl: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel.toLowerCase()}-640x360.jpg`,
    };
  }
  if (host === "youtube.com" || host === "youtu.be") {
    const id = youtubeVideoId(url);
    if (!id) return null;
    return {
      platform: "youtube",
      url: `https://www.youtube.com/watch?v=${id}`,
      videoId: id,
      embedUrl: () => `https://www.youtube.com/embed/${id}?autoplay=1&mute=1`,
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }
  if (host === "kick.com") {
    const channel = url.pathname.match(KICK_CHANNEL)?.[1];
    if (!channel) return null;
    return {
      platform: "kick",
      url: `https://kick.com/${channel}`,
      videoId: null,
      embedUrl: () => `https://player.kick.com/${channel}?muted=true`,
      thumbnailUrl: null,
    };
  }
  return null;
}

/**
 * Metadata URI for a coin: `${publicUrl}/api/meta/<mint>?link=...&seal=...`.
 * `seal` is the server's proof that an invited channel launched this coin (server/invites.ts).
 * Must stay under the 200-byte on-chain limit; it can never change after launch.
 */
export function metadataUri(publicUrl: string, mint: string, link: StreamLink | null, seal?: string): string {
  const base = `${publicUrl.replace(/\/$/, "")}/api/meta/${mint}`;
  const params = new URLSearchParams();
  if (link) params.set("link", link.url);
  if (seal) params.set("seal", seal);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** Reads the stream link back out of a coin's metadata URI; null if none or not ours. */
export function streamLinkFromUri(uri: string): StreamLink | null {
  try {
    const link = new URL(uri).searchParams.get("link");
    return link ? parseStreamLink(link) : null;
  } catch {
    return null;
  }
}

/** The seal in a coin's metadata URI, unchecked; null if none. */
export function sealFromUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("seal");
  } catch {
    return null;
  }
}
