/**
 * Admin sign-in, separate from the predictions feature: turning MEMESTREAM_PREDICTIONS off must not
 * lock the owner out of /admin/fees. Same proof as predictions (the wallet signs one message for
 * this site's domain; lib/predictions/message.ts) and the same token format (identity.ts), signed
 * with MEMESTREAM_PREDICTIONS_SECRET. No points, no Redis.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { bearer, issueToken, verifySessionMessage, walletFromToken } from "@/server/predictions/identity";
import { isBase58Of } from "@/lib/base58";

/** MEMESTREAM_ADMIN_WALLETS: a comma list; entries that aren't addresses are ignored. */
export const isAdmin = (wallet: string) =>
  (process.env.MEMESTREAM_ADMIN_WALLETS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => isBase58Of(w, 32))
    .includes(wallet);

const MIN_SECRET_CHARS = 32;
/** DEV ONLY: without a configured secret, a random one per process. */
let devSecret: string | undefined;

function secret(): string | null {
  const configured = process.env.MEMESTREAM_PREDICTIONS_SECRET ?? "";
  if (configured.length >= MIN_SECRET_CHARS) return configured;
  if (process.env.NODE_ENV === "production") return null;
  return (devSecret ??= randomBytes(32).toString("hex"));
}

function domain(): string | null {
  try {
    return new URL(process.env.MEMESTREAM_PUBLIC_URL ?? "").host;
  } catch {
    return null;
  }
}

export class AdminSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Checks the signed message and that the wallet is an admin; answers a session token. */
export function adminSession(message: string, signature: string, now: number): { wallet: string; token: string; expiresAt: number } {
  const key = secret();
  const host = domain();
  if (!key || !host) throw new AdminSessionError("Admin sign-in is not set up", 503);
  const verified = verifySessionMessage(message, signature, now, host);
  if (!verified.ok) throw new AdminSessionError(verified.error, 400);
  const { wallet } = verified.request;
  if (!isAdmin(wallet)) throw new AdminSessionError("Admins only", 403);
  return { wallet, ...issueToken(wallet, now, key) };
}

/** The signed-in admin's wallet from the request's token; throws (401/403/503) otherwise. */
export function signedInAdmin(request: Request, now: number): string {
  const key = secret();
  if (!key) throw new AdminSessionError("Admin sign-in is not set up", 503);
  const wallet = walletFromToken(bearer(request), now, key);
  if (!wallet) throw new AdminSessionError("Sign in first", 401);
  if (!isAdmin(wallet)) throw new AdminSessionError("Admins only", 403);
  return wallet;
}
