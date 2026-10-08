"use client";
/**
 * Wires the money state machine (lib/tx-flow.ts) to the browser. The per-wallet ledger in
 * localStorage is the only source of truth: the lock, the banner and the unlock button are derived
 * from it (viewOf). This file only stores it, runs one status tracker per own entry, and feeds
 * wallet and network events into it.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useWallet } from "@/components/wallet/WalletProvider";
import type { PreparedTx, TxAction, TxStatus } from "@/lib/api-types";
import { fetchJson, postJson } from "@/lib/http";
import {
  applyEvent,
  begin,
  EMPTY_LEDGER,
  type Entry,
  type FlowEvent,
  isBusy,
  isUserRejection,
  lateSignature,
  type Ledger,
  MESSAGES,
  POLL_MS,
  STALE_AFTER_MS,
  type View,
  viewOf,
} from "@/lib/tx-flow";

const KEY_PREFIX = "memestream.ledger.";
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
/** Used if localStorage writes fail (e.g. full): the in-memory copy still holds the lock. */
const memory: Record<string, Ledger> = {};
/** Keys whose last write failed: localStorage holds an older copy, so memory wins. */
const writeFailed = new Set<string>();

function load(wallet: string): Ledger {
  const key = KEY_PREFIX + wallet;
  if (writeFailed.has(key)) return memory[key] ?? EMPTY_LEDGER;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Ledger) : (memory[key] ?? EMPTY_LEDGER);
  } catch {
    return memory[key] ?? EMPTY_LEDGER;
  }
}

function save(wallet: string, ledger: Ledger) {
  const key = KEY_PREFIX + wallet;
  memory[key] = ledger;
  try {
    localStorage.setItem(key, JSON.stringify(ledger));
    writeFailed.delete(key);
  } catch {
    writeFailed.add(key);
  }
  notify();
}

/** Read-modify-write in one synchronous step (no await in between), so it can't interleave. */
function update(wallet: string, change: (ledger: Ledger) => Ledger): Ledger {
  const next = change(load(wallet));
  save(wallet, next);
  return next;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange); // other tabs' writes
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Stable per-tab id that survives a reload of the same tab. */
function tabId(): string {
  try {
    let id = sessionStorage.getItem("memestream.tab");
    if (!id) sessionStorage.setItem("memestream.tab", (id = crypto.randomUUID()));
    return id;
  } catch {
    return "this-tab";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fetchStatus = (entry: Entry) =>
  fetchJson<TxStatus>(`/api/tx/status?${new URLSearchParams({ blockhash: entry.blockhash, ...(entry.signature ? { signature: entry.signature } : {}) })}`);

/** Polls one entry until it's resolved or waiting for the user. One per entry per tab. */
const running = new Set<string>();
async function trackEntry(wallet: string, id: string) {
  if (running.has(id)) return;
  running.add(id);
  try {
    for (;;) {
      const entry = load(wallet).entries.find((e) => e.id === id);
      if (!entry || entry.phase === "check-wallet") return;
      let event: FlowEvent;
      try {
        event = { type: "status", answer: await fetchStatus(entry) };
      } catch (error) {
        event = { type: "status-error", busy: isBusy(error) };
      }
      update(wallet, (ledger) => applyEvent(ledger, id, event, Date.now()));
      await sleep(POLL_MS);
    }
  } finally {
    running.delete(id);
  }
}

/** How long the button shows "Confirming" before the banner alone takes over. */
const FOREGROUND_WAIT_MS = 90_000;

export type Stage = "Preparing" | "Check your wallet" | "Confirming";

type TxState = {
  view: View;
  locked: boolean;
  unlock: (id: string) => void;
  dismiss: () => void;
  run: <T extends PreparedTx>(action: TxAction, label: string, body: unknown, onStage: (stage: Stage) => void) => Promise<T>;
};

const TxContext = createContext<TxState | null>(null);

export function useTx(): TxState {
  const state = useContext(TxContext);
  if (!state) throw new Error("useTx must be used inside TxProvider");
  return state;
}

const FREE: View = { kind: "free", last: null };

export function TxProvider({ children }: { children: ReactNode }) {
  const { address, signAndSend } = useWallet();
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (address ? JSON.stringify({ ledger: load(address), view: viewOf(load(address), tabId(), Date.now()) }) : "null"),
    () => "null",
  );
  const { ledger, view } = (JSON.parse(snapshot) as { ledger: Ledger; view: View } | null) ?? { ledger: EMPTY_LEDGER, view: FREE };

  // Track every own entry still in flight, including after a reload. A "signing" entry from an
  // earlier page load has lost its wallet prompt: it continues as tracking (row 5).
  const resumed = useRef<string | null>(null);
  useEffect(() => {
    if (!address) return;
    const tab = tabId();
    if (resumed.current !== address) {
      resumed.current = address;
      for (const e of ledger.entries) {
        if (e.tab === tab && e.phase === "signing" && !running.has(e.id)) {
          update(address, (l) => applyEvent(l, e.id, { type: "wallet-error" }, Date.now()));
        }
      }
    }
    for (const e of ledger.entries) if (e.tab === tab && e.phase !== "check-wallet") void trackEntry(address, e.id);
  }, [address, ledger]);

  // Another tab's entry stops locking this tab once stale; re-read then, so no reload is needed.
  useEffect(() => {
    if (view.kind !== "other-tab") return;
    const oldest = Math.min(...ledger.entries.map((e) => e.startedAt));
    const timer = setTimeout(notify, Math.max(0, oldest + STALE_AFTER_MS - Date.now()) + 1_000);
    return () => clearTimeout(timer);
  }, [view.kind, ledger]);

  const run = useCallback(
    async <T extends PreparedTx>(action: TxAction, label: string, body: unknown, onStage: (stage: Stage) => void): Promise<T> => {
      if (!address) throw new Error("Connect a wallet first");
      const wallet = address;
      if (viewOf(load(wallet), tabId(), Date.now()).kind !== "free") throw new Error(MESSAGES.locked);
      onStage("Preparing");
      const prepared = await postJson<T>(`/api/tx/${action}`, body);

      // Lock: check and add in one synchronous step, right before the wallet prompt opens.
      const id = crypto.randomUUID();
      const started = update(wallet, (l) => begin(l, { id, label, tab: tabId(), blockhash: prepared.blockhash }, Date.now()));
      const original = started.entries.find((e) => e.id === id) as Entry;
      void trackEntry(wallet, id); // also catches a wallet that never answers
      onStage("Check your wallet");

      let trackedId = id;
      try {
        const signature = await signAndSend(prepared.transaction);
        const after = update(wallet, (l) => lateSignature(l, original, signature, Date.now()));
        if (!after.entries.some((e) => e.id === id)) trackedId = `${id}-late`; // it had been unlocked meanwhile
        void trackEntry(wallet, trackedId);
      } catch (error) {
        update(wallet, (l) => applyEvent(l, id, isUserRejection(error) ? { type: "rejected" } : { type: "wallet-error" }, Date.now()));
      }

      onStage("Confirming");
      const deadline = Date.now() + FOREGROUND_WAIT_MS;
      for (;;) {
        const current = load(wallet);
        const entry = current.entries.find((e) => e.id === trackedId);
        if (!entry) {
          const last = current.last?.id === trackedId ? current.last : null;
          if (last?.kind === "confirmed") return prepared;
          throw new Error(last?.text ?? MESSAGES.locked);
        }
        if (entry.phase === "check-wallet") throw new Error(entry.message ?? MESSAGES.expired);
        if (Date.now() > deadline) throw new Error("Still confirming. Trading is paused until we know, so you can't pay twice.");
        await sleep(500);
      }
    },
    [address, signAndSend],
  );

  const unlock = useCallback(
    (id: string) => {
      if (address) update(address, (l) => applyEvent(l, id, { type: "unlock" }, Date.now()));
    },
    [address],
  );
  const dismiss = useCallback(() => {
    if (address) update(address, (l) => ({ ...l, last: null }));
  }, [address]);

  const value = useMemo<TxState>(() => ({ view, locked: view.kind !== "free", unlock, dismiss, run }), [view, unlock, dismiss, run]);
  return <TxContext.Provider value={value}>{children}</TxContext.Provider>;
}

/** Under the top bar, derived only from the ledger: paused / check your wallet (with unlock) / last result. */
export function TxBanner() {
  const { view, unlock, dismiss } = useTx();
  let text: string | null = null;
  let error = false;
  let action: ReactNode = null;
  if (view.kind === "confirming") text = `Confirming "${view.label}". Trading is paused until we know, so you can't pay twice.`;
  if (view.kind === "other-tab") text = "A trade is in progress in another tab. Trading is paused until it finishes (at most 10 minutes).";
  if (view.kind === "check-wallet") {
    text = view.message;
    error = true;
    action = (
      <button type="button" className="mbtn" style={{ height: 44, fontSize: 14 }} onClick={() => unlock(view.id)}>
        I checked, unlock
      </button>
    );
  }
  if (view.kind === "free" && view.last && view.last.kind !== "rejected") {
    text = view.last.text;
    error = view.last.kind === "failed";
    action = (
      <button type="button" className="mbtn" style={{ height: 44, fontSize: 14 }} onClick={dismiss} aria-label="Dismiss">
        OK
      </button>
    );
  }
  if (!text) return null;
  return (
    <div className="tx-banner" role={error ? "alert" : "status"}>
      <div className={`notice${error ? " err" : ""}`} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ flex: 1 }}>{text}</span>
        {action}
      </div>
    </div>
  );
}
