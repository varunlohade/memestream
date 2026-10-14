/**
 * The invite rules, pure (no env, no network) so they unit-test: who may launch, and the seal that
 * marks their coins verified. invites.ts wires them to env and the YouTube API.
 *
 * An invite pairs a wallet with a YouTube channel. We check who owns the wallet by hand when we
 * invite them, so at launch the server only checks that the wallet is invited and that the stream
 * is on its own channel.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { LaunchCheck } from "@/lib/api-types";
import { isBase58Of } from "@/lib/base58";
import { type StreamLink, sealFromUri, streamLinkFromUri } from "@/lib/stream-link";
import { UserError } from "./errors";

/** What the YouTube Data API tells us about a video. */
export type YoutubeVideo = {
  channelId: string;
  channelTitle: string;
  /** "live" or "upcoming" for a stream; "none" for a normal video or a finished stream. */
  broadcast: "live" | "upcoming" | "none";
};
export type FetchVideo = (videoId: string) => Promise<YoutubeVideo | null>;

export type InviteSettings =
  /** `invites`: invited wallet -> its YouTube channel ID. */
  | { mode: "invite"; secret: string; invites: ReadonlyMap<string, string>; fetchVideo: FetchVideo }
  /** Anyone launches, no seal: for local and devnet testing. */
  | { mode: "open"; secret: string | null }
  /** Not set up: nobody can launch. */
  | { mode: "closed"; secret: string | null };

const SEAL_LENGTH = 16; // base64url characters: 96 bits, and short enough for the 200-byte URI

/** The seal a verified launch writes into the coin's metadata URI. */
export function coinSeal(secret: string, mint: string, videoId: string): string {
  return createHmac("sha256", secret).update(`seal|${mint}|${videoId}`).digest("base64url").slice(0, SEAL_LENGTH);
}

/** True if this coin's metadata URI carries a seal this server made for its mint and video. */
export function isSealed(secret: string | null, mint: string, uri: string): boolean {
  const videoId = streamLinkFromUri(uri)?.videoId;
  const seal = sealFromUri(uri);
  if (!secret || !videoId || !seal) return false;
  const expected = Buffer.from(coinSeal(secret, mint, videoId));
  const given = Buffer.from(seal);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Is this wallet invited, and (given a link) is the stream live on its own channel? A wallet that
 * isn't invited never costs a YouTube call.
 */
export async function checkLaunch(settings: InviteSettings, wallet: string, link: StreamLink | null): Promise<LaunchCheck> {
  if (settings.mode !== "invite") return { mode: settings.mode };
  const channelId = settings.invites.get(wallet);
  const empty = { mode: "invite", invited: Boolean(channelId), channel: null, ownChannel: false, live: false } as const;
  if (!channelId || !link?.videoId) return empty;
  const video = await settings.fetchVideo(link.videoId).catch((error) => {
    console.warn("YouTube lookup failed:", (error as Error).message);
    throw new UserError("Couldn't reach YouTube. Try again in a moment");
  });
  if (!video) return empty;
  return {
    ...empty,
    channel: video.channelTitle,
    ownChannel: video.channelId === channelId,
    live: video.broadcast === "live" || video.broadcast === "upcoming",
  };
}

/**
 * Throws a user error unless this wallet may launch a coin for this stream now. Returns how to
 * seal the coin (null in open mode: open launches stay unverified).
 */
export async function assertCanLaunch(
  settings: InviteSettings,
  wallet: string,
  link: StreamLink,
): Promise<((mint: string) => string) | null> {
  if (settings.mode === "open") return null;
  if (settings.mode === "closed") throw new UserError("Launches are invite-only, and invites aren't open on this site yet");
  if (!link.videoId) throw new UserError("Paste your YouTube live link");
  const check = await checkLaunch(settings, wallet, link);
  if (check.mode !== "invite") throw new Error("unreachable");
  if (!check.invited) throw new UserError("Launches are invite-only, and this wallet isn't invited");
  if (!check.channel) throw new UserError("YouTube can't find that video. Check the link");
  if (!check.ownChannel) throw new UserError("That stream isn't on your channel. Use your own live link");
  if (!check.live) throw new UserError("Use a live or scheduled stream, not a regular video");
  const { secret } = settings;
  const videoId = link.videoId;
  return (mint) => coinSeal(secret, mint, videoId);
}

type Env = Record<string, string | undefined>;

/** Open launches are never allowed on mainnet, even if the flag is set by mistake. */
const looksLikeMainnet = (env: Env) => (env.MEMESTREAM_WALLET_CHAIN ?? "").includes("mainnet") || (env.MEMESTREAM_RPC_URL ?? "").includes("mainnet");

/** A short secret could be guessed, and then anyone could seal a coin. */
const MIN_SECRET_LENGTH = 32;

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * "wallet:UCchannel,wallet:UCchannel" -> wallet -> channel ID. A malformed entry is skipped with a
 * warning, so a typo invites nobody rather than the wrong wallet.
 */
export function parseInvites(raw: string): Map<string, string> {
  const invites = new Map<string, string>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [wallet, channelId, extra] = entry.split(":").map((part) => part.trim());
    if (extra === undefined && isBase58Of(wallet, 32) && CHANNEL_ID.test(channelId ?? "")) invites.set(wallet, channelId);
    else console.warn(`skipping malformed invite "${entry}": use wallet:UCchannelId`);
  }
  return invites;
}

/** Settings from env (see invites.ts). Anything missing means "closed", never "open". */
export function settingsFromEnv(env: Env, fetchVideoWith: (apiKey: string) => FetchVideo): InviteSettings {
  const raw = env.MEMESTREAM_VERIFY_SECRET ?? "";
  const secret = raw.length >= MIN_SECRET_LENGTH ? raw : null;
  const apiKey = env.YOUTUBE_API_KEY;
  const invites = parseInvites(env.MEMESTREAM_INVITES ?? "");
  if (env.MEMESTREAM_OPEN_LAUNCH === "1" && !looksLikeMainnet(env)) return { mode: "open", secret };
  if (!secret || !apiKey || invites.size === 0) return { mode: "closed", secret };
  return { mode: "invite", secret, invites, fetchVideo: fetchVideoWith(apiKey) };
}
