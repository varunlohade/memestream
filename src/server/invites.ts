/**
 * Invite-only launches: only an invited wallet can launch, and only for a stream on its own
 * YouTube channel (rules in invite-rules.ts). A coin launched this way carries a seal in its
 * metadata URI (an HMAC of its mint and video). Only this server can make one, so a coin launched
 * straight on Meteora can't claim to be verified.
 *
 * Env:
 * - MEMESTREAM_INVITES: invited streamers as wallet:channelId pairs (channel IDs start with UC),
 *   comma separated. Check that the wallet really belongs to the channel owner before adding it.
 * - MEMESTREAM_VERIFY_SECRET: signs seals, 32+ characters. Changing it unverifies every coin.
 * - YOUTUBE_API_KEY: a plain YouTube Data API key (public data only, no sign-in).
 * - MEMESTREAM_OPEN_LAUNCH=1: anyone may launch (coins stay unverified). Local and devnet only.
 */
import "server-only";
import { settingsFromEnv, type YoutubeVideo } from "./invite-rules";

export { assertCanLaunch, checkLaunch, isSealed } from "./invite-rules";

async function fetchYoutubeVideo(apiKey: string, videoId: string): Promise<YoutubeVideo | null> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`YouTube API answered ${res.status}`);
  const body = (await res.json()) as { items?: { snippet?: Record<string, unknown> }[] };
  const snippet = body.items?.[0]?.snippet;
  if (!snippet || typeof snippet.channelId !== "string") return null;
  const broadcast = snippet.liveBroadcastContent;
  return {
    channelId: snippet.channelId,
    channelTitle: typeof snippet.channelTitle === "string" ? snippet.channelTitle : "",
    broadcast: broadcast === "live" || broadcast === "upcoming" ? broadcast : "none",
  };
}

/** Settings from this server's env. Anything missing means "closed", never "open". */
export const inviteSettings = () => settingsFromEnv(process.env, (apiKey) => (videoId) => fetchYoutubeVideo(apiKey, videoId));
