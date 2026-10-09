/**
 * The text a wallet signs to place a free-points prediction. The browser builds it, the wallet
 * signs it (Wallet Standard signMessage), and the server parses and checks the very same text,
 * so every field the server acts on is covered by the signature. A one-time nonce and a short
 * expiry stop a signed message from being replayed.
 */
import { isBase58Of } from "@/lib/base58";
import { isSide, type Side } from "./rules";

export const MESSAGE_HEADER = "memestream predictions: free points, no money, no prizes";
/** A signed message is good for this long (and the server refuses expiries further out). */
export const MESSAGE_TTL_MS = 5 * 60 * 1000;
/** Allowance for a browser clock running ahead of the server's. */
const CLOCK_SKEW_MS = 60 * 1000;
const MAX_POINTS = 1_000_000_000;

export type StakeRequest = { mint: string; side: Side; points: number; wallet: string; nonce: string; expiresAt: number };

const FIELDS = ["Action", "Coin", "Side", "Points", "Wallet", "Nonce", "Expires"] as const;

export function stakeMessage(r: StakeRequest): string {
  const values = ["stake", r.mint, r.side, String(r.points), r.wallet, r.nonce, new Date(r.expiresAt).toISOString()];
  return [MESSAGE_HEADER, ...FIELDS.map((field, i) => `${field}: ${values[i]}`)].join("\n");
}

/** A fresh random nonce (32 hex characters). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type Parsed = { ok: true; request: StakeRequest } | { ok: false; error: string };

/** Parses a signed stake message and checks it is well formed and not expired at `now` (ms). */
export function parseStakeMessage(text: string, now: number): Parsed {
  const lines = text.split("\n");
  if (lines.length !== FIELDS.length + 1 || lines[0] !== MESSAGE_HEADER) return bad("Not a memestream prediction message");
  const values: string[] = [];
  for (let i = 0; i < FIELDS.length; i++) {
    const prefix = `${FIELDS[i]}: `;
    if (!lines[i + 1].startsWith(prefix)) return bad("Not a memestream prediction message");
    values.push(lines[i + 1].slice(prefix.length));
  }
  const [action, mint, side, pointsText, wallet, nonce, expires] = values;
  if (action !== "stake") return bad("Unknown action");
  if (!isBase58Of(mint, 32)) return bad("Not a valid coin address");
  if (!isSide(side)) return bad("Pick YES or NO");
  if (!/^[1-9][0-9]{0,9}$/.test(pointsText) || Number(pointsText) > MAX_POINTS) return bad("Points must be a whole number above 0");
  if (!isBase58Of(wallet, 32)) return bad("Not a valid wallet address");
  if (!/^[0-9a-f]{32}$/.test(nonce)) return bad("Bad nonce");
  const expiresAt = Date.parse(expires);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expires) || Number.isNaN(expiresAt)) return bad("Bad expiry");
  if (expiresAt <= now) return bad("This signature expired. Try again.");
  if (expiresAt - now > MESSAGE_TTL_MS + CLOCK_SKEW_MS) return bad("Expiry too far ahead. Check your clock.");
  return { ok: true, request: { mint, side, points: Number(pointsText), wallet, nonce, expiresAt } };
}

const bad = (error: string): Parsed => ({ ok: false, error });
