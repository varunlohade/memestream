"use client";
/**
 * Runs a transaction: the server builds it, the wallet signs and sends it, then we poll its status
 * until it lands, fails or expires. No lock: other trades stay open while one confirms. The banner
 * shows only the last result (went through / failed), kept in memory for this tab.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useWallet } from "@/components/wallet/WalletProvider";
import { solscanTx } from "@/lib/explorer";
import type { PreparedTx, TxAction, TxStatus } from "@/lib/api-types";
import { fetchJson, postJson } from "@/lib/http";
import { isBusy, isUserRejection, type LastResult, MESSAGES, POLL_MS, type View } from "@/lib/tx-flow";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long to wait for an answer before telling the user to check their wallet. */
const CONFIRM_WAIT_MS = 120_000;
const UNKNOWN = "We couldn't confirm it yet. Check your wallet history before you try again.";

export type Stage = "Preparing" | "Check your wallet" | "Confirming";

type TxState = {
  view: View;
  /** Always false: kept so callers don't change. */
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

/** Polls the status route until the transaction lands or fails; null if there's no answer in time. */
async function waitForResult(signature: string, blockhash: string): Promise<TxStatus | null> {
  const deadline = Date.now() + CONFIRM_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const answer = await fetchJson<TxStatus>(`/api/tx/status?${new URLSearchParams({ signature, blockhash })}`);
      if (answer.status === "confirmed" || answer.status === "failed") return answer;
    } catch (error) {
      if (!isBusy(error)) console.warn("tx status check failed:", (error as Error).message);
    }
    await sleep(POLL_MS);
  }
  return null;
}

export function TxProvider({ children }: { children: ReactNode }) {
  const { address, signAndSend } = useWallet();
  const [last, setLast] = useState<LastResult | null>(null);

  const run = useCallback(
    async <T extends PreparedTx>(action: TxAction, _label: string, body: unknown, onStage: (stage: Stage) => void): Promise<T> => {
      if (!address) throw new Error("Connect a wallet first");
      const id = crypto.randomUUID();
      onStage("Preparing");
      const prepared = await postJson<T>(`/api/tx/${action}`, body);
      onStage("Check your wallet");
      let signature: string;
      try {
        signature = await signAndSend(prepared.transaction);
      } catch (error) {
        throw new Error(isUserRejection(error) ? MESSAGES.rejected : (error as Error).message || "Your wallet couldn't send it");
      }
      onStage("Confirming");
      const answer = await waitForResult(signature, prepared.blockhash);
      if (answer?.status === "confirmed") {
        setLast({ id, kind: "confirmed", text: MESSAGES.confirmed, signature });
        return prepared;
      }
      const text = answer?.status === "failed" ? MESSAGES.failed(answer.error) : UNKNOWN;
      setLast({ id, kind: "failed", text, signature });
      throw new Error(text);
    },
    [address, signAndSend],
  );

  const dismiss = useCallback(() => setLast(null), []);
  const value = useMemo<TxState>(() => ({ view: { kind: "free", last }, locked: false, unlock: () => {}, dismiss, run }), [last, dismiss, run]);
  return <TxContext.Provider value={value}>{children}</TxContext.Provider>;
}

/** Under the top bar: the last result (went through / failed), with a link to Solscan. */
export function TxBanner() {
  const { view, unlock, dismiss } = useTx();
  const { chain } = useWallet();
  let text: string | null = null;
  let signature: string | null = null;
  let error = false;
  let action: ReactNode = null;
  if (view.kind === "confirming") text = `Confirming "${view.label}". Trading is paused until we know, so you can't pay twice.`;
  if (view.kind === "other-tab") text = "A trade is in progress in another tab. Trading is paused until it finishes (at most 10 minutes).";
  if (view.kind === "check-wallet") {
    text = view.message;
    error = true;
    signature = view.signature;
    action = (
      <button type="button" className="mbtn" style={{ height: 44, fontSize: 14 }} onClick={() => unlock(view.id)}>
        I checked, unlock
      </button>
    );
  }
  if (view.kind === "free" && view.last && view.last.kind !== "rejected") {
    text = view.last.text;
    error = view.last.kind === "failed";
    signature = view.last.signature ?? null;
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
        {signature && (
          <a href={solscanTx(signature, chain)} target="_blank" rel="noopener noreferrer">
            View on Solscan
          </a>
        )}
        {action}
      </div>
    </div>
  );
}
