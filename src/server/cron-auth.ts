import "server-only";
import { timingSafeEqual } from "node:crypto";

const MIN_SECRET_CHARS = 32;

const sameSecret = (given: string, secret: string) => {
  const [a, b] = [Buffer.from(given), Buffer.from(secret)];
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * A scheduler's call: MEMESTREAM_CRON_SECRET (32+ characters; unset or short: cron routes are off),
 * checked in constant time, from the x-cron-secret header or Vercel Cron's "Authorization: Bearer <secret>".
 */
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.MEMESTREAM_CRON_SECRET ?? "";
  if (secret.length < MIN_SECRET_CHARS) return false;
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  return sameSecret(request.headers.get("x-cron-secret") ?? "", secret) || sameSecret(bearer, secret);
}
