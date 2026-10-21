/** When the client keeps or drops its predictions session (the server's token lasts SESSION_TTL_MS, 6 h). */
import type { Session } from "./view";

/** A saved session is dropped this long before it expires, so no request goes out on a token about to lapse. */
export const SESSION_EXPIRY_MARGIN_MS = 60_000;

/** The saved session counts for `wallet` now: its own, and not about to expire. */
export const sessionUsable = (session: Session | null, wallet: string | null, now: number) =>
  Boolean(session && wallet && session.wallet === wallet && session.expiresAt > now + SESSION_EXPIRY_MARGIN_MS);

/** When the client drops it on its own. */
export const sessionDropAt = (session: Session) => session.expiresAt - SESSION_EXPIRY_MARGIN_MS;

/**
 * The server answered a request made with `sentToken` as anonymous (`me: null`): that session is dead
 * on the server (expired early, or its secret changed). Dropped only if it is still the one saved, so
 * a fresh sign-in made while the request was out is kept.
 */
export const serverDroppedSession = (sentToken: string | null, savedToken: string | null, me: unknown) =>
  sentToken !== null && me === null && savedToken === sentToken;
