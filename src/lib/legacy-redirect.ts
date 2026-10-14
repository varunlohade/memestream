/**
 * The old Vercel address shared with the hackathon judges (memestream-iota.vercel.app) must keep
 * working and must land on the DEVNET site, never on mainnet. next.config.ts sends it to
 * MEMESTREAM_LEGACY_REDIRECT (default https://devnet.memestream.lol). The same config works in both
 * Vercel projects; "off" turns the redirect off. A target on the old host itself is refused, so
 * it can never loop.
 */
export const LEGACY_HOST = "memestream-iota.vercel.app";
export const DEFAULT_LEGACY_REDIRECT = "https://devnet.memestream.lol";

/** The redirect's target origin, or null when it is off. Throws on a target that would loop. */
export function legacyRedirectTarget(env: Record<string, string | undefined> = process.env): string | null {
  const value = (env.MEMESTREAM_LEGACY_REDIRECT ?? DEFAULT_LEGACY_REDIRECT).trim();
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
