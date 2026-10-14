"use client";
/** Buy/sell panel. Quotes as you type; the server builds the swap; the wallet signs it. */
import { useState, useSyncExternalStore } from "react";
import { type CoinView, type Holdings, useQuote } from "@/components/hooks";
import { noSubscription } from "@/components/no-subscription";
import { useTx } from "@/components/tx";
import { useWallet } from "@/components/wallet/WalletProvider";
import { COIN_DECIMALS, DEFAULT_SLIPPAGE_BPS, SOL_DECIMALS } from "@/lib/api-types";
import { atMost, compact, fractionOf, isOver, minusReserve, SIDE_LABEL } from "@/lib/format";
import { LAUNCH_FEE, launchFeeAt } from "@/lib/launch-fee";
import { UNVERIFIED_BUY_MESSAGE, UNVERIFIED_MAX_BUY_SOL } from "@/lib/unverified";

type Side = "buy" | "sell";

/** SOL kept back on "Max" buys for network fees and the new token account's rent. */
const SOL_RESERVE = "0.01";

type Chip = { label: string; amount: string | null };

/**
 * Buy: fixed SOL amounts plus Max. Sell: shares of what the wallet holds. Null amount = unavailable.
 * `buyLimit` (unverified coins) turns off bigger chips and caps Max.
 */
function chipsFor(side: Side, holdings: Holdings | null, buyLimit: string | null): Chip[] {
  if (side === "buy") {
    const within = (amount: string) => (buyLimit && isOver(amount, buyLimit, SOL_DECIMALS) ? null : amount);
    const max = holdings ? minusReserve(holdings.sol, SOL_RESERVE, SOL_DECIMALS) : null;
    return [
      { label: "0.1", amount: within("0.1") },
      { label: "0.5", amount: within("0.5") },
      { label: "1", amount: within("1") },
      { label: "Max", amount: max && buyLimit ? atMost(max, buyLimit, SOL_DECIMALS) : max },
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
  const buyLimit = coin.verified ? null : UNVERIFIED_MAX_BUY_SOL;
  const amount = typed ?? saved ?? (side === "buy" && buyLimit ? buyLimit : DEFAULT_AMOUNT[side]);
  const setAmount = (value: string) => {
    setTyped(value);
    saveAmount(coin.mint, side, value);
  };
  const [status, setStatus] = useState<Status | null>(null);
  const { preview, error: quoteError, loading } = useQuote(coin.mint, side, amount, coin.raisedSol);

  const unit = side === "buy" ? "SOL" : coin.symbol;
  const actionLabel = `${SIDE_LABEL[side]} ${coin.symbol}`;
  const blocked = side === "buy" && address === coin.creator;
  const overLimit = side === "buy" && buyLimit !== null && isOver(amount, buyLimit, SOL_DECIMALS);
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
      ? "Can't buy your own coin"
      : overLimit
        ? `Max ${buyLimit} SOL per buy`
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
        {chipsFor(side, holdings, buyLimit).map((chip) => (
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
        <>
          <div className="get mute" style={{ fontSize: 22 }}>
            <span>You hold</span>
            <span className="num">
              {compact(Number(holdings.coins))} {coin.symbol}
            </span>
          </div>
          <div className="get mute" style={{ fontSize: 22 }}>
            <span>Wallet</span>
            <span className="num">{compact(Number(holdings.sol))} SOL</span>
          </div>
        </>
      )}
      {coin.status === "trading" && <LaunchFeeLine launchedAt={coin.launchedAt} />}
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
      {overLimit && (
        <p className="notice err" style={{ marginBottom: 12 }}>
          {UNVERIFIED_BUY_MESSAGE}. Nobody has checked who launched it.
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
        disabled={!address || blocked || overLimit || !preview || busy || Boolean(locked)}
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

/**
 * During a coin's first minute: the anti-sniper fee right now and a live countdown to the 1% base,
 * so early buyers aren't surprised. "You get about" already includes it (the quote uses the
 * on-chain schedule). Gone once the minute is over. Times come from the viewer's clock, so they
 * can be off by a second or two.
 */
function LaunchFeeLine({ launchedAt }: { launchedAt: number }) {
  const nowSeconds = useSyncExternalStore(everySecond, () => Math.floor(Date.now() / 1000), () => null);
  if (nowSeconds === null) return null; // server render: the clock is the viewer's
  const fee = launchFeeAt(nowSeconds - launchedAt);
  if (fee.secondsLeft <= 0) return null;
  const percent = (fee.bps / 100).toFixed(fee.bps % 100 === 0 ? 0 : 1);
  return (
    <p className="mute launch-fee" role="status">
      Launch fee now <span className={fee.bps > HIGH_FEE_BPS ? "down" : undefined}>{percent}%</span>, drops to{" "}
      {LAUNCH_FEE.endingFeeBps / 100}% in {fee.secondsLeft}s
    </p>
  );
}

/** Above this the fee number shows in red, so a buyer about to pay it notices. */
const HIGH_FEE_BPS = 1_000;

/** Re-reads the clock once a second while the line is on screen. */
function everySecond(onTick: () => void) {
  const timer = setInterval(onTick, 1_000);
  return () => clearInterval(timer);
}
