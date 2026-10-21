/**
 * The old Vercel address shared with the hackathon judges (memestream-iota.vercel.app) must keep
 * working and must land on the DEVNET site, never on mainnet. next.config.ts sends it to
 * MEMESTREAM_LEGACY_REDIRECT. Without it, a mainnet deploy sends it to https://devnet.memestream.lol,
 * and a devnet deploy (www is still devnet) keeps today's target, https://www.memestream.lol. So no
 * deploy order can send the judges to a site that doesn't exist yet. "off" turns the redirect off.
 * A target on the old host itself is refused, so it can never loop.
 */
import { isMainnet } from "./network";

export const LEGACY_HOST = "memestream-iota.vercel.app";
export const DEFAULT_LEGACY_REDIRECT = "https://devnet.memestream.lol";
/** While www still runs devnet, the old link keeps going to www, as it always has. */
export const DEVNET_LEGACY_REDIRECT = "https://www.memestream.lol";

/** The redirect's target origin, or null when it is off. Throws on a target that would loop. */
export function legacyRedirectTarget(env: Record<string, string | undefined> = process.env): string | null {
  const fallback = isMainnet(env) ? DEFAULT_LEGACY_REDIRECT : DEVNET_LEGACY_REDIRECT;
  const value = (env.MEMESTREAM_LEGACY_REDIRECT ?? fallback).trim();
  if (value === "off") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`MEMESTREAM_LEGACY_REDIRECT is not a URL (or "off").`);
  }
  if (url.protocol !== "https:") throw new Error("MEMESTREAM_LEGACY_REDIRECT must be https.");
  if (url.hostname === LEGACY_HOST) throw new Error(`MEMESTREAM_LEGACY_REDIRECT can't point at ${LEGACY_HOST} itself (a redirect loop).`);
  return url.origin;
}
