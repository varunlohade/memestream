// One test per row of the state table in tx-flow.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TxStatus } from "./api-types";
import {
  applyEvent,
  begin,
  BUSY_GIVE_UP_MS,
  EMPTY_LEDGER,
  type Entry,
  EXPIRY_GRACE_MS,
  isBusy,
  isUserRejection,
  type Ledger,
  lateSignature,
  lockOwner,
  MAX_STATUS_ERRORS,
  MESSAGES,
  MIN_UNLOCK_AFTER_MS,
  STALE_AFTER_MS,
  viewOf,
} from "./tx-flow";

const TAB = "tab-1";
const T0 = 1_000_000;
const status = (answer: TxStatus["status"], error?: string) => ({ type: "status" as const, answer: { status: answer, error } });
const started = (): Ledger => begin(EMPTY_LEDGER, { id: "a", label: "Buy MIRA", tab: TAB, blockhash: "h" }, T0);
const entry = (l: Ledger, id = "a"): Entry | undefined => l.entries.find((e) => e.id === id);
const signed = (at = T0) => applyEvent(started(), "a", { type: "signed", signature: "sig" }, at);
const view = (l: Ledger, now: number) => viewOf(l, TAB, now);

test("row 1: begin locks, phase signing, no unlock", () => {
  const l = started();
  assert.equal(entry(l)?.phase, "signing");
  assert.equal(lockOwner(l, TAB, T0), "mine");
  assert.equal(view(l, T0).kind, "confirming");
});

test("row 2: a second action is refused while one is pending (this tab or a fresh other tab)", () => {
  const l = started();
  assert.throws(() => begin(l, { id: "b", label: "x", tab: TAB, blockhash: "h" }, T0), new RegExp(MESSAGES.locked));
  assert.throws(() => begin(l, { id: "b", label: "x", tab: "tab-2", blockhash: "h" }, T0 + 1), new RegExp(MESSAGES.locked));
  // Another tab's entry stops locking once stale, and is dropped when a new action begins.
  const later = begin(l, { id: "b", label: "x", tab: "tab-2", blockhash: "h" }, T0 + STALE_AFTER_MS);
  assert.deepEqual(later.entries.map((e) => e.id), ["b"]);
});

test("row 3: a wallet rejection removes the entry and frees the wallet", () => {
  const l = applyEvent(started(), "a", { type: "rejected" }, T0);
  assert.equal(l.entries.length, 0);
  assert.equal(l.last?.kind, "rejected");
  assert.ok(isUserRejection({ code: 4001 }) && !isUserRejection(new Error("User rejected")));
});

test("row 4: signed -> tracking, and the clock restarts at signing", () => {
  const l = signed(T0 + 80_000);
  assert.equal(entry(l)?.phase, "tracking");
  assert.equal(entry(l)?.startedAt, T0 + 80_000);
});

test("row 5: wallet error (or reload) -> tracking without a signature, still locked, clock restarts", () => {
  const l = applyEvent(started(), "a", { type: "wallet-error" }, T0 + 70_000);
  assert.equal(entry(l)?.phase, "tracking");
  assert.equal(entry(l)?.startedAt, T0 + 70_000);
  assert.equal(entry(l)?.signature, null);
  assert.equal(view(l, T0).kind, "confirming");
});

test("row 6: confirmed removes the entry with a 'went through' result", () => {
  const l = applyEvent(signed(), "a", status("confirmed"), T0);
  assert.equal(l.entries.length, 0);
  assert.deepEqual(view(l, T0), { kind: "free", last: { id: "a", kind: "confirmed", text: MESSAGES.confirmed } });
});

test("row 7: failed removes the entry with the reason", () => {
  const l = applyEvent(signed(), "a", status("failed", "slippage"), T0);
  assert.equal(l.entries.length, 0);
  assert.equal(l.last?.text, MESSAGES.failed("slippage"));
});

test("row 8: pending keeps tracking and resets error counts", () => {
  const withErrors = applyEvent(signed(), "a", { type: "status-error", busy: false }, T0);
  const l = applyEvent(withErrors, "a", status("pending"), T0);
  assert.equal(entry(l)?.phase, "tracking");
  assert.equal(entry(l)?.errors, 0);
});

test("row 9: expired before the grace window or the minimum wait stays tracking (no unlock)", () => {
  let l = applyEvent(signed(), "a", status("expired"), T0); // starts the grace window
  l = applyEvent(l, "a", status("expired"), T0 + EXPIRY_GRACE_MS); // grace passed, minimum not
  assert.equal(entry(l)?.phase, "tracking");
  assert.equal(view(l, T0 + EXPIRY_GRACE_MS).kind, "confirming");
});

test("row 10: expired past the grace window AND the minimum -> check-wallet with unlock", () => {
  let l = applyEvent(signed(), "a", status("expired"), T0 + MIN_UNLOCK_AFTER_MS - EXPIRY_GRACE_MS);
  l = applyEvent(l, "a", status("expired"), T0 + MIN_UNLOCK_AFTER_MS);
  assert.equal(entry(l)?.phase, "check-wallet");
  assert.equal(view(l, T0 + MIN_UNLOCK_AFTER_MS).kind, "check-wallet");
  // Without a signature (wallet never answered) the message says so.
  let silent = applyEvent(started(), "a", status("expired"), T0 + MIN_UNLOCK_AFTER_MS - EXPIRY_GRACE_MS);
  silent = applyEvent(silent, "a", status("expired"), T0 + MIN_UNLOCK_AFTER_MS);
  assert.equal(entry(silent)?.message, MESSAGES.walletSilent);
});

test("row 11: status errors or endless 'busy' give up only past the minimum wait", () => {
  let l = signed();
  for (let i = 0; i < MAX_STATUS_ERRORS; i++) l = applyEvent(l, "a", { type: "status-error", busy: false }, T0 + 1_000);
  assert.equal(entry(l)?.phase, "tracking", "too early even with many errors");
  l = applyEvent(l, "a", { type: "status-error", busy: false }, T0 + MIN_UNLOCK_AFTER_MS);
  assert.equal(entry(l)?.phase, "check-wallet");

  let busy = applyEvent(signed(), "a", { type: "status-error", busy: true }, T0);
  busy = applyEvent(busy, "a", { type: "status-error", busy: true }, T0 + BUSY_GIVE_UP_MS - 1);
  assert.equal(entry(busy)?.phase, "tracking");
  busy = applyEvent(busy, "a", { type: "status-error", busy: true }, T0 + BUSY_GIVE_UP_MS);
  assert.equal(entry(busy)?.phase, "check-wallet");
  assert.ok(isBusy({ status: 503 }) && isBusy({ status: 429 }) && !isBusy({ status: 500 }));
});

const toCheckWallet = (l: Ledger) =>
  applyEvent(applyEvent(l, "a", status("expired"), T0), "a", status("expired"), T0 + MIN_UNLOCK_AFTER_MS);

test("row 12: a late signature on a check-wallet entry -> tracking again, unlock hidden, clock restarts", () => {
  const waiting = toCheckWallet(started());
  const now = T0 + MIN_UNLOCK_AFTER_MS + 5_000;
  const l = lateSignature(waiting, entry(waiting) as Entry, "late", now);
  assert.equal(entry(l)?.phase, "tracking");
  assert.equal(entry(l)?.startedAt, now);
  assert.equal(view(l, now).kind, "confirming", "the unlock button is gone");
});

test("row 13: a late signature after the user unlocked -> a NEW tracked entry; another trade isn't overwritten", () => {
  const waiting = toCheckWallet(started());
  const original = entry(waiting) as Entry;
  const unlocked = applyEvent(waiting, "a", { type: "unlock" }, T0 + MIN_UNLOCK_AFTER_MS);
  const tradeB = begin(unlocked, { id: "b", label: "Sell MIRA", tab: TAB, blockhash: "h2" }, T0 + MIN_UNLOCK_AFTER_MS + 1);
  const l = lateSignature(tradeB, original, "late", T0 + MIN_UNLOCK_AFTER_MS + 2);
  assert.deepEqual(l.entries.map((e) => [e.id, e.signature]), [
    ["b", null],
    ["a-late", "late"],
  ]);
  // B confirming doesn't free the wallet while A's late transaction is still tracked.
  const bDone = applyEvent(l, "b", status("confirmed"), T0 + MIN_UNLOCK_AFTER_MS + 3);
  assert.equal(lockOwner(bDone, TAB, T0 + MIN_UNLOCK_AFTER_MS + 3), "mine");
});

test("row 14: unlock removes a check-wallet entry", () => {
  const l = applyEvent(toCheckWallet(started()), "a", { type: "unlock" }, T0 + MIN_UNLOCK_AFTER_MS);
  assert.equal(l.entries.length, 0);
});

test("row 15: unlock is ignored while signing or tracking", () => {
  assert.equal(entry(applyEvent(started(), "a", { type: "unlock" }, T0))?.phase, "signing");
  assert.equal(entry(applyEvent(signed(), "a", { type: "unlock" }, T0))?.phase, "tracking");
});

const waitingNow = T0 + MIN_UNLOCK_AFTER_MS;
const unchanged = (event: Parameters<typeof applyEvent>[2]) => {
  const waiting = toCheckWallet(started());
  assert.deepEqual(applyEvent(waiting, "a", event, waitingNow + 1), waiting);
};

test("row 16: check-wallet ignores status answers (it's the user's call now)", () => {
  unchanged(status("confirmed"));
  unchanged(status("pending"));
});
test("row 17: check-wallet ignores status errors and busy answers", () => {
  unchanged({ type: "status-error", busy: false });
  unchanged({ type: "status-error", busy: true });
});
test("row 18: check-wallet ignores a wallet rejection", () => unchanged({ type: "rejected" }));
test("row 19: check-wallet ignores a wallet error", () => unchanged({ type: "wallet-error" }));

test("row 20: tracking ignores a rejection (it may already be signed)", () => {
  const l = signed();
  assert.deepEqual(applyEvent(l, "a", { type: "rejected" }, T0 + 1), l);
});
test("row 21: tracking ignores a wallet error", () => {
  const l = signed();
  assert.deepEqual(applyEvent(l, "a", { type: "wallet-error" }, T0 + 1), l);
});
test("row 22: signing + status failed -> removed with the reason", () => {
  const l = applyEvent(started(), "a", status("failed", "x"), T0);
  assert.equal(l.entries.length, 0);
  assert.equal(l.last?.kind, "failed");
});
test("row 23: begin with only stale other-tab entries starts, dropping them", () => {
  const otherTab = begin(EMPTY_LEDGER, { id: "old", label: "x", tab: "tab-2", blockhash: "h" }, T0);
  const l = begin(otherTab, { id: "new", label: "y", tab: TAB, blockhash: "h" }, T0 + STALE_AFTER_MS);
  assert.deepEqual(l.entries.map((e) => [e.id, e.phase]), [["new", "signing"]]);
});

test("unlock never shows sooner than the minimum after the wallet prompt opened (silent wallet)", () => {
  // The chain says expired from the very start; a prompt still open in this tab stays locked until the minimum.
  let l = started();
  for (let t = T0; t < T0 + MIN_UNLOCK_AFTER_MS; t += 3_000) {
    l = applyEvent(l, "a", status("expired"), t);
    assert.equal(view(l, t).kind, "confirming", `no unlock at +${t - T0} ms`);
  }
});
