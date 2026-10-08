"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { useTx } from "@/components/tx";
import type { PreparedTx } from "@/lib/api-types";
import { Sprite } from "@/components/pixel/Pixel";
import { useWallet } from "@/components/wallet/WalletProvider";
import { parseStreamLink } from "@/lib/stream-link";

/** How often to re-ask the server while the launch fee is still unknown (RPC busy). */
const FEE_RETRY_MS = 5_000;

/**
 * `launchFeeSol`: the config's launch fee ("0" = free), or null while unknown. A streamer must see
 * the cost before paying it, so Launch stays disabled until the fee is known.
 */
export function GoLiveView({ launchFeeSol }: { launchFeeSol: string | null }) {
  const router = useRouter();
  const feeKnown = launchFeeSol !== null;
  useEffect(() => {
    if (feeKnown) return;
    const timer = setInterval(() => router.refresh(), FEE_RETRY_MS); // re-renders the server part; the form keeps its state
    return () => clearInterval(timer);
  }, [feeKnown, router]);
  const { address } = useWallet();
  const { run, locked } = useTx();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [status, setStatus] = useState<{ busy: boolean; error?: string; text?: string } | null>(null);

  const platform = parseStreamLink(streamUrl)?.platform;
  const linkProblem = streamUrl.trim() && platform !== "youtube" && platform !== "twitch" ? "Use a YouTube or Twitch live link" : null;
  const ready = feeKnown && address && name.trim() && symbol.trim() && streamUrl.trim() && !linkProblem && !status?.busy && !locked;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!address) return;
    try {
      const { mint } = await run<PreparedTx & { mint: string }>("launch", `Launch $${symbol}`, { wallet: address, name, symbol, streamUrl }, (stage) =>
        setStatus({ busy: true, text: stage }),
      );
      router.push(`/coin/${mint}`);
    } catch (e) {
      setStatus({ busy: false, error: (e as Error).message });
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <div className="p" style={{ padding: 32 }}>
        <h1>Go live</h1>
        <p className="sub mute">Launch a coin for this stream in one transaction.</p>
        {/* No image field yet: the coin icon is the stream's picture (SPEC: upload not built). */}
        <label className="f">
          <span className="flabel">Stream name</span>
          <input className="slot in" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ranked till Diamond" maxLength={32} required />
        </label>
        <label className="f">
          <span className="flabel">Ticker</span>
          <input
            className="slot in"
            value={symbol ? `$${symbol}` : ""}
            onChange={(e) => setSymbol(e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10))}
            placeholder="$MIRA"
            required
          />
        </label>
        <label className="f">
          <span className="flabel">Stream link</span>
          <input
            className="slot in"
            value={streamUrl}
            onChange={(e) => setStreamUrl(e.target.value)}
            placeholder="YouTube or Twitch live link"
            required
            inputMode="url"
            aria-invalid={Boolean(linkProblem)}
            aria-describedby={linkProblem ? "link-error" : undefined}
          />
          {linkProblem && (
            <span id="link-error" className="notice err" style={{ display: "block", marginTop: 8 }}>
              {linkProblem}
            </span>
          )}
        </label>
        <div className="earn">
          <Sprite name="heart" />
          <span>80% of trade fees go to you. memestream won&apos;t let your wallet buy your own coin.</span>
        </div>
        {(!feeKnown || Number(launchFeeSol) > 0) && (
          <p className="mute" style={{ fontSize: 22, margin: "-8px 0 16px" }}>
            {feeKnown ? `Launch costs ${launchFeeSol} SOL.` : "Launch fee: checking…"}
          </p>
        )}
        <button type="submit" className="mbtn buy" style={{ width: "100%" }} disabled={!ready}>
          {!address ? "Connect a wallet" : status?.busy ? status.text : "Launch coin"}
        </button>
        {status?.error && <p className="notice err" style={{ marginTop: 12 }} role="alert">{status.error}</p>}
        <p className="mute" style={{ fontSize: 22, marginTop: 14 }}>
          <Link href="/">Back to live coins</Link>
        </p>
      </div>
    </form>
  );
}
