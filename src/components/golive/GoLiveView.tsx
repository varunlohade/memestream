"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { useTx } from "@/components/tx";
import type { LaunchCheck, PreparedTx } from "@/lib/api-types";
import { Sprite } from "@/components/pixel/Pixel";
import { useWallet } from "@/components/wallet/WalletProvider";
import { fetchJson, postJson } from "@/lib/http";
import { parseStreamLink } from "@/lib/stream-link";

/** How often to re-ask while the launch fee is still unknown (RPC busy). */
const FEE_RETRY_MS = 5_000;

/**
 * Our config's launch fee in SOL ("0" = free), or null while unknown. It's fixed on-chain, so
 * one answer is enough; until then, retry.
 */
function useLaunchFee(): string | null {
  const [fee, setFee] = useState<string | null>(null);
  useEffect(() => {
    if (fee !== null) return;
    let stopped = false;
    const ask = () =>
      fetchJson<{ sol: string }>("/api/launch-fee")
        .then(({ sol }) => !stopped && setFee(sol))
        .catch(() => {}); // busy: the timer asks again
    void ask();
    const timer = setInterval(ask, FEE_RETRY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [fee]);
  return fee;
}

/** Wait for typing to stop before asking YouTube about the link. */
const CHECK_DELAY_MS = 600;

/**
 * Asks the server whether this wallet is invited and, once there's a link, whether the stream is
 * live on its own channel. `recheck` asks again (say, once the stream goes live).
 */
function useLaunchCheck(wallet: string | null, streamUrl: string) {
  const [result, setResult] = useState<{ key: string; round: number; check?: LaunchCheck; error?: string } | null>(null);
  const [round, setRound] = useState(0);
  const key = `${wallet}|${streamUrl.trim()}`;
  useEffect(() => {
    // An empty link checks the wallet alone; a half-typed one waits.
    if (!wallet || (streamUrl.trim() && !parseStreamLink(streamUrl))) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      postJson<LaunchCheck>("/api/launch-check", { wallet, streamUrl }, abort.signal)
        .then((check) => setResult({ key, round, check }))
        .catch((e: Error) => !abort.signal.aborted && setResult({ key, round, error: e.message }));
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [wallet, streamUrl, key, round]);
  // An answer for an older link or wallet doesn't count; while re-checking, the last answer stays up.
  const current = result?.key === key ? result : null;
  return {
    check: current?.check ?? null,
    error: current?.error ?? null,
    checking: !current || current.round !== round,
    recheck: () => setRound((r) => r + 1),
  };
}

/** A streamer must see the launch cost before paying it, so Launch stays disabled until it's known. */
export function GoLiveView() {
  const router = useRouter();
  const launchFeeSol = useLaunchFee();
  const feeKnown = launchFeeSol !== null;
  const { address } = useWallet();
  const { run, locked } = useTx();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [status, setStatus] = useState<{ busy: boolean; error?: string; text?: string } | null>(null);

  const launchCheck = useLaunchCheck(address, streamUrl);
  const { check } = launchCheck;
  // Invite mode takes YouTube only; open mode (testing) takes Twitch too.
  const youtubeOnly = check?.mode !== "open";
  const platform = parseStreamLink(streamUrl)?.platform;
  const linkProblem =
    streamUrl.trim() && platform !== "youtube" && (youtubeOnly || platform !== "twitch")
      ? youtubeOnly
        ? "Use a YouTube live link. Launches are invite-only, YouTube first"
        : "Use a YouTube or Twitch live link"
      : null;
  const allowed = check?.mode === "open" || (check?.mode === "invite" && check.invited && check.ownChannel && check.live);
  const ready = feeKnown && address && allowed && name.trim() && symbol.trim() && streamUrl.trim() && !linkProblem && !status?.busy && !locked;

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
        <p className="sub mute">Launch a coin for this stream in one transaction. Invited YouTube streamers only, for now.</p>
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
            placeholder={youtubeOnly ? "YouTube live link" : "YouTube or Twitch live link"}
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
        {address && !linkProblem && <InviteStatus hasLink={Boolean(parseStreamLink(streamUrl))} {...launchCheck} />}
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

/** Where the streamer stands: invited or not, and whether this stream is live on their channel. */
function InviteStatus({ hasLink, check, error, checking, recheck }: ReturnType<typeof useLaunchCheck> & { hasLink: boolean }) {
  const problem = (text: string, retry = false) => (
    <p className="notice err" style={{ marginBottom: 16 }} role="alert">
      {text}
      {retry && (
        <>
          {" "}
          <button type="button" className="linkish" onClick={recheck} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
        </>
      )}
    </p>
  );
  if (error) return problem(error, true);
  if (!check) return checking ? <p className="mute" style={{ fontSize: 22, marginBottom: 16 }}>Checking your invite…</p> : null;
  if (check.mode !== "invite") return check.mode === "closed" ? problem("Launches are invite-only, and invites aren't open on this site yet.") : null;
  if (!check.invited) return problem("Launches are invite-only, and this wallet isn't invited. Connect the wallet you were invited with.");
  if (!hasLink) return <p className="notice" style={{ marginBottom: 16 }}>You&apos;re invited. Paste your YouTube live link.</p>;
  if (checking && !check.channel) return <p className="mute" style={{ fontSize: 22, marginBottom: 16 }}>Checking your stream…</p>;
  if (!check.channel) return problem("YouTube can't find that video. Check the link.");
  if (!check.ownChannel) return problem(`That stream is on ${check.channel}, not your channel. Use your own live link.`);
  if (!check.live) return problem("That's a regular video. Use a live or scheduled stream.", true);
  return (
    <p className="notice" style={{ marginBottom: 16 }} role="status">
      Invited as {check.channel}. Your coin will show as verified.
    </p>
  );
}
