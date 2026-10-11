/**
 * The one message a wallet signs to start a predictions session, in Sign-In-With-Solana form.
 * Wallets with the Wallet Standard signIn feature build it themselves from `signInInput` (and
 * check the domain against the page they run on); others sign this same text with signMessage.
 * It names the site's domain, which the server checks against its
 * own, so a signature made for another site can't sign in here. A one-time nonce and a short
 * expiry stop replays. After that, the server's session token identifies the wallet, so
 * heartbeats and bets need no more popups.
 */
import { isBase58Of } from "@/lib/base58";

export const STATEMENT = "memestream predictions: free points, no money, no prizes. Signing in costs nothing and sends nothing.";
/** A signed message is good for this long (and the server refuses expiries further out). */
export const MESSAGE_TTL_MS = 5 * 60 * 1000;
/** Allowance for a browser clock running ahead of the server's. */
const CLOCK_SKEW_MS = 60 * 1000;

export type SessionRequest = { domain: string; wallet: string; nonce: string; expiresAt: number };

export function sessionMessage(r: SessionRequest): string {
  return [
    `${r.domain} wants you to sign in with your Solana account:`,
    r.wallet,
    "",
    STATEMENT,
    "",
    `Nonce: ${r.nonce}`,
    `Expiration Time: ${new Date(r.expiresAt).toISOString()}`,
  ].join("\n");
}

/**
 * The Wallet Standard `solana:signIn` input whose message is exactly `sessionMessage(r)`: the
 * standard text has only the fields given, in this order, so the server parses it as before.
 */
export function signInInput(r: SessionRequest) {
  return { domain: r.domain, address: r.wallet, statement: STATEMENT, nonce: r.nonce, expirationTime: new Date(r.expiresAt).toISOString() };
}

/** A fresh random nonce (32 hex characters). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type Parsed = { ok: true; request: SessionRequest } | { ok: false; error: string };
const bad = (error: string): Parsed => ({ ok: false, error });

const SHAPE = /^(\S+) wants you to sign in with your Solana account:\n(\S+)\n\n(.*)\n\nNonce: (\S+)\nExpiration Time: (\S+)$/;

/** Parses a signed session message; checks it is for `domain`, well formed, and not expired at `now` (ms). */
export function parseSessionMessage(text: string, now: number, domain: string): Parsed {
  const match = SHAPE.exec(text);
  if (!match || match[3] !== STATEMENT) return bad("Not a memestream predictions message");
  const [, signedDomain, wallet, , nonce, expires] = match;
  if (signedDomain !== domain) return bad("This sign-in was made for another site");
  if (!isBase58Of(wallet, 32)) return bad("Not a valid wallet address");
  if (!/^[0-9a-f]{32}$/.test(nonce)) return bad("Bad nonce");
  const expiresAt = Date.parse(expires);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expires) || Number.isNaN(expiresAt)) return bad("Bad expiry");
  if (expiresAt <= now) return bad("This signature expired. Try again.");
  if (expiresAt - now > MESSAGE_TTL_MS + CLOCK_SKEW_MS) return bad("Expiry too far ahead. Check your clock.");
  return { ok: true, request: { domain, wallet, nonce, expiresAt } };
}
