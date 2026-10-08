"use client";
/** Buy/sell panel. Quotes as you type; the server builds the swap; the wallet signs it. */
import { useState, useSyncExternalStore } from "react";
import { type CoinView, type Holdings, useQuote } from "@/components/hooks";
import { noSubscription } from "@/components/no-subscription";
import { useTx } from "@/components/tx";
import { useWallet } from "@/components/wallet/WalletProvider";
import { COIN_DECIMALS, DEFAULT_SLIPPAGE_BPS, SOL_DECIMALS } from "@/lib/api-types";
import { compact, fractionOf, minusReserve, SIDE_LABEL } from "@/lib/format";

type Side = "buy" | "sell";

/** SOL kept back on "Max" buys for network fees and the new token account's rent. */
const SOL_RESERVE = "0.01";

type Chip = { label: string; amount: string | null };

/** Buy: fixed SOL amounts plus Max. Sell: shares of what the wallet holds. Null amount = unavailable. */
function chipsFor(side: Side, holdings: Holdings | null): Chip[] {
  if (side === "buy") {
    return [
      { label: "0.1", amount: "0.1" },
      { label: "0.5", amount: "0.5" },
      { label: "1", amount: "1" },
      { label: "Max", amount: holdings ? minusReserve(holdings.sol, SOL_RESERVE, SOL_DECIMALS) : null },
    ];
  }
  const share = (percent: number) => (holdings ? fractionOf(holdings.coins, percent, COIN_DECIMALS) : null);
  return [
    { label: "25%", amount: share(25) },
    { label: "50%", amount: share(50) },
    { label: "Max", amount: share(100) },
  ];
}

type Status = { kind: "busy" | "done" | "error"; text: string };

/** The typed amount survives a reload (per coin and side) via sessionStorage; this tab only. */
const amountKey = (mint: string, side: Side) => `memestream.amount.${mint}.${side}`;
const DEFAULT_AMOUNT: Record<Side, string> = { buy: "0.5", sell: "" };
function readAmount(mint: string, side: Side): string | null {
  try {
    return sessionStorage.getItem(amountKey(mint, side));
  } catch {
    return null;
  }
}
function saveAmount(mint: string, side: Side, amount: string) {
  try {
    sessionStorage.setItem(amountKey(mint, side), amount);
  } catch {
    // storage blocked: the amount just won't survive a reload
  }
}

export function TradeBox({ coin, holdings, onTraded }: { coin: CoinView; holdings: Holdings | null; onTraded: () => void }) {
  const { address } = useWallet();
  const { run, locked } = useTx();
  const [side, setSide] = useState<Side>("buy");
  /** null = nothing typed in this page view yet: show the saved amount (or the default). */
  const [typed, setTyped] = useState<string | null>(null);
  const saved = useSyncExternalStore(noSubscription, () => readAmount(coin.mint, side), () => null);
  const amount = typed ?? saved ?? DEFAULT_AMOUNT[side];
  const setAmount = (value: string) => {
    setTyped(value);
    saveAmount(coin.mint, side, value);
  };
  const [status, setStatus] = useState<Status | null>(null);
  const { preview, error: quoteError, loading } = useQuote(coin.mint, side, amount);

  const unit = side === "buy" ? "SOL" : coin.symbol;
  const actionLabel = `${SIDE_LABEL[side]} ${coin.symbol}`;
  const blocked = side === "buy" && address === coin.creator;
  const busy = status?.kind === "busy";

  const submit = async () => {
    if (!address) return;
    try {
      await run("trade", actionLabel, { wallet: address, mint: coin.mint, side, amount, slippageBps: DEFAULT_SLIPPAGE_BPS, minReceived: preview?.minimumReceived }, (stage) =>
        setStatus({ kind: "busy", text: stage }),
      );
      setStatus({ kind: "done", text: side === "buy" ? `Bought ${coin.symbol}` : `Sold ${coin.symbol}` });
      onTraded();
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  };

  const label = !address
    ? "Connect a wallet"
    : blocked
      ? "Streamers can't buy their own coin here"
      : busy
        ? status.text
        : locked
          ? "Paused: checking your last trade"
          : actionLabel;

  return (
    <section className="p" aria-label="Trade">
      <div className="tabs" role="group" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            className={`mbtn ${side === s ? s : "off"}`}
            onClick={() => {
              setSide(s);
              setTyped(null); // show that side's saved amount, or its default
              setStatus(null);
            }}
          >
            {SIDE_LABEL[s]}
          </button>
        ))}
      </div>
      <div className="slot amt num">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          aria-label={`Amount in ${unit}`}
          aria-invalid={Boolean(quoteError)}
          aria-describedby={quoteError ? "trade-error" : undefined}
        />
        <small aria-hidden>{unit}</small>
      </div>
      <div className={`chips num${side === "buy" ? " four" : ""}`}>
        {chipsFor(side, holdings).map((chip) => (
          <button
            type="button"
            key={chip.label}
            className="slot"
            disabled={!chip.amount || chip.amount === "0"}
            onClick={() => chip.amount && setAmount(chip.amount)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {holdings && (
        <div className="get mute" style={{ fontSize: 22 }}>
          <span>You hold</span>
          <span className="num">
            {compact(Number(holdings.coins))} {coin.symbol} · {compact(Number(holdings.sol))} SOL
          </span>
        </div>
      )}
      <div className="get">
        <span className="mute">You get about</span>
        <span className="num" aria-live="polite">
          {preview ? `${compact(Number(preview.received))} ${side === "buy" ? coin.symbol : "SOL"}` : loading ? "…" : "-"}
        </span>
      </div>
      {preview?.partial && (
        <p className="notice" style={{ marginBottom: 12 }}>
          This fills the curve. Only {compact(Number(preview.spent))} {unit} is spent; the rest stays in your wallet.
        </p>
      )}
      {quoteError && (
        <p id="trade-error" className="notice err" role="alert" style={{ marginBottom: 12 }}>
          {quoteError}
        </p>
      )}
      <button
        type="button"
        className={`mbtn ${side}`}
        style={{ width: "100%" }}
        disabled={!address || blocked || !preview || busy || Boolean(locked)}
        onClick={submit}
      >
        {label}
      </button>
      {status && status.kind !== "busy" && (
        <p className={`notice${status.kind === "error" ? " err" : ""}`} style={{ marginTop: 12 }} role="status">
          {status.text}
        </p>
      )}
      {!address && <p className="mute" style={{ fontSize: 22, marginTop: 10 }}>Use the heart button at the top to connect.</p>}
    </section>
  );
}
