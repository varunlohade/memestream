/**
 * The money flow as a small state machine over a per-wallet ledger (stored in localStorage by the
 * UI). The ledger is the ONLY source of truth: the lock, the banner and the unlock button are all
 * derived from it. Pure functions; time comes in as `now`.
 *
 * Rule that prevents paying twice: while the ledger holds any entry, no new action starts, and an
 * entry can only be removed (unlocked) by the user once it's in "check-wallet", which is reached
 * only when the transaction can no longer land (or the user must check their wallet history).
 *
 * STATE TABLE (one test per row in tx-flow.test.ts)
 * | #  | state        | event                       | next state                 | locked | unlock button |
 * |----|--------------|-----------------------------|----------------------------|--------|---------------|
 * | 1  | (none)       | begin                       | signing                    | yes    | no            |
 * | 2  | any entry    | begin (another action)      | refused, ledger unchanged  | yes    | (unchanged)   |
 * | 3  | signing      | wallet rejected (code 4001) | removed                    | no*    | -             |
 * | 4  | signing      | wallet signed               | tracking, clock restarts   | yes    | no            |
 * | 5  | signing      | wallet error / page reload  | tracking (no signature)    | yes    | no            |
 * | 6  | sign./track. | status confirmed            | removed, result "went thru"| no*    | -             |
 * | 7  | tracking     | status failed               | removed, result "failed"   | no*    | -             |
 * | 8  | sign./track. | status pending              | unchanged                  | yes    | no            |
 * | 9  | sign./track. | status expired, < grace/min | unchanged                  | yes    | no            |
 * | 10 | sign./track. | status expired, >= grace&min| check-wallet               | yes    | yes           |
 * | 11 | sign./track. | status errors/busy, give up | check-wallet               | yes    | yes           |
 * | 12 | check-wallet | late signature              | tracking, clock restarts   | yes    | no            |
 * | 13 | (removed)    | late signature              | NEW tracking entry         | yes    | no            |
 * | 14 | check-wallet | user unlock                 | removed                    | no*    | -             |
 * | 15 | sign./track. | user unlock                 | unchanged (not allowed)    | yes    | no            |
 * | 16 | check-wallet | status (any answer)         | unchanged (no polling)     | yes    | yes           |
 * | 17 | check-wallet | status error / busy         | unchanged                  | yes    | yes           |
 * | 18 | check-wallet | wallet rejected             | unchanged                  | yes    | yes           |
 * | 19 | check-wallet | wallet error                | unchanged                  | yes    | yes           |
 * | 20 | tracking     | wallet rejected             | unchanged (may be signed)  | yes    | no            |
 * | 21 | tracking     | wallet error                | unchanged                  | yes    | no            |
 * | 22 | signing      | status failed               | removed, result "failed"   | no*    | -             |
 * | 23 | only stale   | begin                       | signing; stale dropped     | yes    | no            |
 * |    | other-tab    |                             |                            |        |               |
 * * "no" if no other entry remains; every entry must resolve before the wallet is free.
 * Row 5 restarts the clock: the wallet may have signed just before it failed.
 * By construction (rows 10, 11), unlock is never offered sooner than MIN_UNLOCK_AFTER_MS after the
 * wallet prompt opened, so a prompt still pending in this tab can't be unlocked early.
 *
 * KNOWN MVP LIMIT: a wallet popup left open longer than that (or in a closed tab for more than
 * STALE_AFTER_MS) can still be signed after the user unlocks. A transaction built by our server
 * can't land once its blockhash expires, so this only matters for wallets that swap in a fresh
 * blockhash. The unlock copy tells users to reject any open popup first.
 * "min" = MIN_UNLOCK_AFTER_MS since startedAt (the prompt opening, or the signature if known).
 */
import type { TxStatus } from "./api-types";

export type Phase = "signing" | "tracking" | "check-wallet";

export type Entry = {
  id: string;
  /** Shown in banners, e.g. "Buy MIRA". */
  label: string;
  /** The tab that owns it (sessionStorage id, survives reload); only that tab tracks it. */
  tab: string;
  /** The blockhash the server built the transaction with. */
  blockhash: string;
  signature: string | null;
  /** When the wallet prompt opened, or when the signature arrived (the clock restarts then). */
  startedAt: number;
  phase: Phase;
  /** Why the user must check their wallet (phase check-wallet only). */
  message: string | null;
  /** Bookkeeping for giving up on status checks. */
  errors: number;
  busySince: number | null;
  expiredAt: number | null;
};

/** `signature` is the landed or failed transaction, for an explorer link (null if never signed). */
export type LastResult = { id: string; kind: "confirmed" | "failed" | "rejected"; text: string; signature?: string | null };
export type Ledger = { entries: Entry[]; last: LastResult | null };
export const EMPTY_LEDGER: Ledger = { entries: [], last: null };

export type FlowEvent =
  | { type: "rejected" }
  | { type: "signed"; signature: string }
  | { type: "wallet-error" }
  | { type: "status"; answer: TxStatus }
  | { type: "status-error"; busy: boolean }
  | { type: "unlock" };

export const POLL_MS = 3_000;
export const MAX_STATUS_ERRORS = 5;
/** After the server's blockhash expires, keep watching (~150 slots): a wallet may use its own newer one. */
export const EXPIRY_GRACE_MS = 60_000;
/** The longest a blockhash can stay valid (150 blocks), with margin for slow slots. */
export const BLOCKHASH_MAX_LIFE_MS = 90_000;
/** Unlock is never offered sooner than this after `startedAt`. */
export const MIN_UNLOCK_AFTER_MS = BLOCKHASH_MAX_LIFE_MS + EXPIRY_GRACE_MS;
/** If the network only answers "busy" this long (past the minimum), stop and ask the user. */
export const BUSY_GIVE_UP_MS = 5 * 60_000;
/** Another tab's entry locks this tab only while it's this fresh. */
export const STALE_AFTER_MS = 10 * 60_000;

export const MESSAGES = {
  locked: "A trade is in progress. Wait for it to finish.",
  expired: "We couldn't confirm it. Wait 2 minutes, then check your wallet history before unlocking. If a wallet popup is still open, reject it first.",
  statusErrors:
    "We can't reach the network to confirm it. Wait 2 minutes, then check your wallet history before unlocking. If a wallet popup is still open, reject it first.",
  walletSilent: "Your wallet never answered. If its popup is still open, reject it first. Then check your wallet history before unlocking.",
  confirmed: "Your last transaction went through.",
  rejected: "You rejected it in your wallet. Nothing was sent.",
  failed: (error?: string) => `Transaction failed on-chain${error ? `: ${error}` : ""}`,
} as const;

/** Only an explicit user rejection counts; message text is never trusted. */
export const isUserRejection = (error: unknown) => (error as { code?: unknown } | null)?.code === 4001;
/** "Busy" answers (rate limited / RPC budget spent) don't count as failures. */
export const isBusy = (error: unknown) => [429, 503].includes((error as { status?: unknown } | null)?.status as number);

const fresh = (entry: Entry, now: number, patch: Partial<Entry>): Entry => ({
  ...entry,
  startedAt: now,
  errors: 0,
  busySince: null,
  expiredAt: null,
  message: null,
  ...patch,
});
const checkWallet = (entry: Entry, message: string): Entry => ({ ...entry, phase: "check-wallet", message });
const minPassed = (entry: Entry, now: number) => now - entry.startedAt >= MIN_UNLOCK_AFTER_MS;

/** One entry's transition (rows 3-12, 14, 15). Returns the next entry (null = removed) and any result. */
export function step(entry: Entry, event: FlowEvent, now: number): { next: Entry | null; result?: Omit<LastResult, "id"> } {
  const active = entry.phase !== "check-wallet";
  switch (event.type) {
    case "rejected": // row 3 (only meaningful before anything was signed)
      return entry.phase === "signing" && entry.signature === null
        ? { next: null, result: { kind: "rejected", text: MESSAGES.rejected } }
        : { next: entry };
    case "signed": // rows 4, 12
      return { next: fresh(entry, now, { phase: "tracking", signature: event.signature }) };
    case "wallet-error": // rows 5, 19, 21 (the wallet may have signed just before failing: restart the clock)
      return { next: entry.phase === "signing" ? fresh(entry, now, { phase: "tracking" }) : entry };
    case "unlock": // rows 14, 15
      return { next: entry.phase === "check-wallet" ? null : entry };
    case "status": {
      if (!active) return { next: entry };
      const { answer } = event;
      if (answer.status === "confirmed") return { next: null, result: { kind: "confirmed", text: MESSAGES.confirmed, signature: entry.signature } }; // row 6
      if (answer.status === "failed") return { next: null, result: { kind: "failed", text: MESSAGES.failed(answer.error), signature: entry.signature } }; // row 7
      const ok = { ...entry, errors: 0, busySince: null };
      if (answer.status === "pending") return { next: ok }; // row 8
      const expiredAt = entry.expiredAt ?? now; // rows 9, 10
      if (now - expiredAt >= EXPIRY_GRACE_MS && minPassed(entry, now)) {
        return { next: checkWallet({ ...ok, expiredAt }, entry.signature ? MESSAGES.expired : MESSAGES.walletSilent) };
      }
      return { next: { ...ok, expiredAt } };
    }
    case "status-error": {
      if (!active) return { next: entry };
      const errors = event.busy ? entry.errors : entry.errors + 1;
      const busySince = event.busy ? (entry.busySince ?? now) : entry.busySince;
      const giveUp =
        minPassed(entry, now) && (errors >= MAX_STATUS_ERRORS || (busySince !== null && now - busySince >= BUSY_GIVE_UP_MS));
      const next = { ...entry, errors, busySince };
      return { next: giveUp ? checkWallet(next, MESSAGES.statusErrors) : next }; // row 11
    }
  }
}

/** Applies an event to one entry of the ledger. Unknown ids are ignored (it was already resolved). */
export function applyEvent(ledger: Ledger, id: string, event: FlowEvent, now: number): Ledger {
  const entry = ledger.entries.find((e) => e.id === id);
  if (!entry) return ledger;
  const { next, result } = step(entry, event, now);
  const entries = next ? ledger.entries.map((e) => (e.id === id ? next : e)) : ledger.entries.filter((e) => e.id !== id);
  return { entries, last: result ? { id, ...result } : ledger.last };
}

/** Whose entries (if any) block a new action in this tab. */
export function lockOwner(ledger: Ledger, tab: string, now: number): "free" | "mine" | "other" {
  if (ledger.entries.some((e) => e.tab === tab)) return "mine";
  return ledger.entries.some((e) => now - e.startedAt < STALE_AFTER_MS) ? "other" : "free";
}

/** Rows 1-2: start an action. Throws (ledger unchanged) if anything is pending. */
export function begin(ledger: Ledger, entry: Pick<Entry, "id" | "label" | "tab" | "blockhash">, now: number): Ledger {
  if (lockOwner(ledger, entry.tab, now) !== "free") throw new Error(MESSAGES.locked);
  const created: Entry = { ...entry, signature: null, startedAt: now, phase: "signing", message: null, errors: 0, busySince: null, expiredAt: null };
  // Stale entries of closed tabs (they no longer lock) are dropped here.
  return { entries: [created], last: null };
}

/** Rows 12-13: a signature that arrives late. Re-tracks its own entry, or adds a new one if it was unlocked. */
export function lateSignature(ledger: Ledger, original: Entry, signature: string, now: number): Ledger {
  if (ledger.entries.some((e) => e.id === original.id)) return applyEvent(ledger, original.id, { type: "signed", signature }, now);
  const revived = fresh({ ...original, id: `${original.id}-late` }, now, { phase: "tracking", signature });
  return { ...ledger, entries: [...ledger.entries, revived] };
}

/** What the UI shows, derived only from the ledger. */
export type View =
  | { kind: "free"; last: LastResult | null }
  | { kind: "confirming"; label: string }
  | { kind: "other-tab" }
  | { kind: "check-wallet"; id: string; label: string; message: string; signature: string | null };

export function viewOf(ledger: Ledger, tab: string, now: number): View {
  const owner = lockOwner(ledger, tab, now);
  if (owner === "other") return { kind: "other-tab" };
  if (owner === "free") return { kind: "free", last: ledger.last };
  const mine = ledger.entries.filter((e) => e.tab === tab);
  // Unlock is offered only when no own entry is still being tracked; a tracking entry hides it.
  const tracking = mine.find((e) => e.phase !== "check-wallet");
  if (tracking) return { kind: "confirming", label: tracking.label };
  const waiting = mine[0];
  return { kind: "check-wallet", id: waiting.id, label: waiting.label, message: waiting.message ?? MESSAGES.expired, signature: waiting.signature };
}
