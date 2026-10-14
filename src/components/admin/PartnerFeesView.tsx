"use client";
/**
 * /admin/fees: memestream's own fees on the shared config (launch fees and its trading fee share).
 * Plain text and one button. The button signs in (the predictions session; the server checks the
 * wallet is an admin), then shows what's claimable, then claims: the server builds the claim
 * transactions unsigned and the connected wallet, the config's fee claimer, signs each one.
 */
import { useState } from "react";
import bs58 from "bs58";
import { useWallet } from "@/components/wallet/WalletProvider";
import type { PreparedTx, TxStatus } from "@/lib/api-types";
import { fetchJson, postJson } from "@/lib/http";
import { newNonce, MESSAGE_TTL_MS, sessionMessage, signInInput } from "@/lib/predictions/message";
import type { Session } from "@/lib/predictions/view";
import { solscanTx } from "@/lib/explorer";

/** Same storage key as the predictions panel, so one sign-in serves both. */
const SESSION_KEY = "memestream.predictions.session";
const SESSION_EXPIRY_MARGIN_MS = 60_000;
const STATUS_POLL_MS = 2_000;
const STATUS_WAIT_MS = 90_000;
/** Claim transactions per button press (about 4 coins each); press again for the rest. */
const MAX_CLAIM_ROUNDS = 10;

type Summary = { feeClaimer: string; canClaim: boolean; claimableSol: string; coinsWithFees: number; coins: number };

function savedToken(wallet: string): string | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
    return s && s.wallet === wallet && s.expiresAt > Date.now() + SESSION_EXPIRY_MARGIN_MS ? s.token : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // storage blocked: sign in again next time
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(signature: string, blockhash: string): Promise<TxStatus["status"] | "unknown"> {
  const deadline = Date.now() + STATUS_WAIT_MS;
  while (Date.now() < deadline) {
    const answer = await fetchJson<TxStatus>(`/api/tx/status?${new URLSearchParams({ signature, blockhash })}`).catch(() => null);
    if (answer && answer.status !== "pending") return answer.status;
    await sleep(STATUS_POLL_MS);
  }
  return "unknown";
}

export function PartnerFeesView() {
  const { address, chain, signIn, signAndSend } = useWallet();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const token = async (wallet: string): Promise<string> => {
    const saved = savedToken(wallet);
    if (saved) return saved;
    if (!signIn) throw new Error("This wallet can't sign in");
    const request = { domain: window.location.host, wallet, nonce: newNonce(), expiresAt: Date.now() + MESSAGE_TTL_MS };
    const { signedMessage, signature } = await signIn(signInInput(request), new TextEncoder().encode(sessionMessage(request)));
    const session = await postJson<Session>("/api/predictions/session", { message: new TextDecoder().decode(signedMessage), signature: bs58.encode(signature) });
    saveSession(session);
    return session.token;
  };

  const load = async (auth: string) => setSummary(await fetchJson<Summary>("/api/admin/fees", { headers: { authorization: `Bearer ${auth}` } }));

  /** One transaction per request, each built with a fresh blockhash just before it's signed. */
  const claim = async (auth: string) => {
    for (let n = 1; n <= MAX_CLAIM_ROUNDS; n++) {
      const { transactions, more } = await fetchJson<{ transactions: PreparedTx[]; more: boolean }>("/api/admin/fees", { method: "POST", headers: { authorization: `Bearer ${auth}` } });
      for (const tx of transactions) {
        const signature = await signAndSend(tx.transaction);
        const status = await waitFor(signature, tx.blockhash);
        setLines((prev) => [...prev, `Claim ${n}: ${status}. ${solscanTx(signature, chain)}`]);
        if (status !== "confirmed") throw new Error("A claim didn't go through. Check it on Solscan, then press the button again.");
      }
      if (!more) return;
    }
    setLines((prev) => [...prev, "More fees are left. Press the button again."]);
  };

  const onClick = async () => {
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await token(address);
      if (summary?.canClaim && summary.coinsWithFees > 0) await claim(auth);
      await load(auth);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = !address ? "Connect a wallet" : busy ? "Working..." : !summary ? "Sign in and check fees" : summary.canClaim && summary.coinsWithFees > 0 ? `Claim ${summary.claimableSol} SOL` : "Check again";

  return (
    <div className="p" style={{ padding: 32, maxWidth: 720 }}>
      <h1>Partner fees</h1>
      <p className="sub mute">memestream&apos;s launch fees and trading fee share. Admins only.</p>
      {summary && (
        <>
          <p>Fee claimer: {summary.feeClaimer}</p>
          <p>
            Unclaimed: {summary.claimableSol} SOL from {summary.coinsWithFees} of {summary.coins} coins.
          </p>
          {!summary.canClaim && <p className="mute">Only the fee claimer wallet can claim. Connect it to claim.</p>}
        </>
      )}
      <button type="button" className="mbtn buy" onClick={onClick} disabled={!address || busy}>
        {label}
      </button>
      {lines.map((line) => (
        <p key={line} className="mute" style={{ wordBreak: "break-all" }}>
          {line}
        </p>
      ))}
      {error && (
        <p className="notice err" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
    </div>
  );
}
