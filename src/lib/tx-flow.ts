/**
 * The money flow's shared pieces, pure (no browser APIs): how the app polls a sent transaction, its
 * result texts, and how a failed wallet signing is read for the server's double-pay hold
 * (tx-intents.ts). The flow itself is in components/tx.tsx; nothing is stored in the browser.
 */

/** The last result in a tab, shown in the banner; `signature` is for the explorer link (null if never signed). */
export type LastResult = { id: string; kind: "confirmed" | "failed" | "rejected"; text: string; signature?: string | null };

/** How often a sent transaction's status is polled. */
export const POLL_MS = 3_000;

export const MESSAGES = {
  confirmed: "Your last transaction went through.",
  rejected: "You rejected it in your wallet. Nothing was sent.",
  failed: (error?: string) => `Transaction failed on-chain${error ? `: ${error}` : ""}`,
} as const;

/** Thrown by the app before any wallet is asked to sign (no wallet connected): nothing can have been sent. */
export class WalletNotConnected extends Error {
  constructor() {
    super("Connect a wallet first");
    this.name = "WalletNotConnected";
  }
}

/**
 * Why signing failed, for the server's double-pay hold. Message text is never trusted: a wallet may
 * report "simulation failed: already processed" for a transaction that went out, or "cancelled" when
 * its session dropped after sending. The hold is dropped only when nothing can have been sent:
 * - "rejected": the user rejected it in the wallet (code 4001);
 * - "not-sent": the app isn't allowed to ask (code 4100), or our own error before the wallet was asked.
 * Anything else from the sign-and-send call is "maybe-sent": the hold is kept as for a signed trade.
 */
export function walletFailure(error: unknown): "rejected" | "not-sent" | "maybe-sent" {
  if (error instanceof WalletNotConnected) return "not-sent";
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) return "rejected";
  if (code === 4100) return "not-sent";
  return "maybe-sent";
}

/** Characters of a wallet's own error message shown. */
const WALLET_SAID_MAX = 140;
/** A wallet's own error, plainly prefixed and cut short; null when it gave no message. */
export function walletSaid(error: unknown): string | null {
  const message = String((error as { message?: unknown } | null)?.message ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!message) return null;
  return `Your wallet said: ${message.length > WALLET_SAID_MAX ? `${message.slice(0, WALLET_SAID_MAX - 1)}…` : message}`;
}
/** "Busy" answers (rate limited / RPC budget spent) don't count as failures. */
export const isBusy = (error: unknown) => [429, 503].includes((error as { status?: unknown } | null)?.status as number);
