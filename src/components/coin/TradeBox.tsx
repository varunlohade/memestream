"use client";
/** Buy/sell panel (pump.fun layout). Quotes as you type; the server builds the swap; the wallet signs it. */
import { useState, useSyncExternalStore } from "react";
import { type CoinView, type Holdings, type TradePreview, useQuote } from "@/components/hooks";
import { noSubscription } from "@/components/no-subscription";
import { useTx } from "@/components/tx";
import { useWallet } from "@/components/wallet/WalletProvider";
import { DEFAULT_SLIPPAGE_BPS, SLIPPAGE_CHOICES_BPS } from "@/lib/api-types";
import { fetchJson } from "@/lib/http";
import { compact, SIDE_LABEL } from "@/lib/format";
import { LAUNCH_FEE, launchFeeAt } from "@/lib/launch-fee";
import { amountKey, convertTyped, freshFloor, NATURAL_UNIT, quoteUrl, type Side, slippageLabel, tradeAmount, tradeChips, type Unit, unitKey } from "@/lib/trade-box";

type Status = { kind: "busy" | "done" | "error"; text: string };

const DEFAULT_AMOUNT: Record<Side, string> = { buy: "0.5", sell: "" };

/** The typed amount and its unit live in sessionStorage (amountKey, unitKey); the max slippage is a browser-wide choice in localStorage. */
const SLIPPAGE_KEY = "memestream.slippageBps";

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}
function save(storage: () => Storage, key: string, value: string) {
  try {
    storage().setItem(key, value);
  } catch {
    // storage blocked: the choice just won't survive a reload
  }
}
const session = () => sessionStorage;
const local = () => localStorage;

const asUnit = (value: string | null): Unit | null => (value === "sol" || value === "coin" ? value : null);
function asSlippage(value: string | null): number | null {
  const bps = Number(value);
  return value !== null && (SLIPPAGE_CHOICES_BPS as readonly number[]).includes(bps) ? bps : null;
}

export function TradeBox({ coin, holdings, onTraded }: { coin: CoinView; holdings: Holdings | null; onTraded: () => void }) {
  const { address } = useWallet();
  const { run, locked } = useTx();
  const [side, setSide] = useState<Side>("buy");

  const [pickedUnits, setPickedUnits] = useState<Partial<Record<Side, Unit>>>({});
  const savedUnit = useSyncExternalStore(noSubscription, () => asUnit(read(session, unitKey(coin.mint, side))), () => null);
  const unit = pickedUnits[side] ?? savedUnit ?? NATURAL_UNIT[side];

  /** null = nothing typed in this page view yet: show the saved amount (or the default). */
  const [typed, setTyped] = useState<string | null>(null);
  const saved = useSyncExternalStore(noSubscription, () => read(session, amountKey(coin.mint, side)), () => null);
  const amount = typed ?? saved ?? (unit === NATURAL_UNIT[side] ? DEFAULT_AMOUNT[side] : "");
  const setAmount = (value: string) => {
    setTyped(value);
    save(session, amountKey(coin.mint, side), value);
  };

  const [pickedSlippage, setPickedSlippage] = useState<number | null>(null);
  const savedSlippage = useSyncExternalStore(noSubscription, () => asSlippage(read(local, SLIPPAGE_KEY)), () => null);
  const chosenSlippage = pickedSlippage ?? savedSlippage;
  const slippageBps = chosenSlippage ?? DEFAULT_SLIPPAGE_BPS;
  const [slippageOpen, setSlippageOpen] = useState(false);

  /** What the trade sends: SOL for a buy, coins for a sell, converted at the coin's price if typed in the other unit. */
  const sent = tradeAmount(side, unit, amount, coin.priceSol, holdings?.coins ?? null);
  const converted = unit !== NATURAL_UNIT[side];

  const [status, setStatus] = useState<Status | null>(null);
  const { preview, error: quoteError, loading, refresh: refreshQuote } = useQuote(coin.mint, side, sent, coin.raisedSol, slippageBps);

  const unitLabel = unit === "sol" ? "SOL" : coin.symbol;
  const spendLabel = side === "buy" ? "SOL" : coin.symbol;
  const receiveLabel = side === "buy" ? coin.symbol : "SOL";
  const actionLabel = `${SIDE_LABEL[side]} ${coin.symbol}`;
  const blocked = side === "buy" && address === coin.creator;
  const busy = status?.kind === "busy";

  const switchUnit = () => {
    const next: Unit = unit === "sol" ? "coin" : "sol";
    setAmount(convertTyped(amount, unit, coin.priceSol));
    setPickedUnits((units) => ({ ...units, [side]: next }));
    save(session, unitKey(coin.mint, side), next);
  };

  const pickSlippage = (bps: number) => {
    setPickedSlippage(bps);
    save(local, SLIPPAGE_KEY, String(bps));
    setSlippageOpen(false);
  };

  const submit = async () => {
    if (!address) return;
    try {
      // The floor comes from a quote fetched now, never the one on screen; a worse one is shown first.
      setStatus({ kind: "busy", text: "Preparing" });
      const latest = await fetchJson<TradePreview>(quoteUrl(coin.mint, side, sent, slippageBps));
      const checked = freshFloor(side, preview?.minimumReceived, latest.minimumReceived);
      if ("moved" in checked) {
        refreshQuote();
        setStatus({ kind: "error", text: "The price moved. Check the new amount and place the trade again." });
        return;
      }
      await run("trade", actionLabel, { wallet: address, mint: coin.mint, side, amount: sent, slippageBps, minReceived: checked.floor }, (stage) =>
        setStatus({ kind: "busy", text: stage }),
      );
      setStatus({ kind: "done", text: side === "buy" ? `Bought ${coin.symbol}` : `Sold ${coin.symbol}` });
      onTraded();
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
    refreshQuote();
  };

  const label = !address
    ? "Connect a wallet"
    : blocked
      ? "Can't buy your own coin"
      : busy
        ? status.text
        : locked
          ? "Paused: checking your last trade"
          : "Place trade";

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
      <div className="tb-links">
        <button type="button" className="tb-link" onClick={switchUnit}>
          {unit === "sol" ? `switch to $${coin.symbol}` : "switch to SOL"}
        </button>
        <button type="button" className="tb-link" aria-expanded={slippageOpen} onClick={() => setSlippageOpen((open) => !open)}>
          {chosenSlippage === null ? "set max slippage" : `slippage: ${slippageLabel(chosenSlippage)}`}
        </button>
      </div>
      {slippageOpen && (
        <div className="chips num" role="group" aria-label="Max slippage">
          {SLIPPAGE_CHOICES_BPS.map((bps) => (
            <button type="button" key={bps} className="slot" aria-pressed={bps === slippageBps} onClick={() => pickSlippage(bps)}>
              {slippageLabel(bps)}
            </button>
          ))}
        </div>
      )}
      <div className="amt num">
        <input
          inputMode="decimal"
          value={amount}
          placeholder="0.0"
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          aria-label={`Amount in ${unitLabel}`}
          aria-invalid={Boolean(quoteError)}
          aria-describedby={quoteError ? "trade-error" : undefined}
        />
        <small aria-hidden>{unitLabel}</small>
      </div>
      <div className="chips num">
        {tradeChips(side, unit, holdings, coin.priceSol).map((chip) => (
          <button
            type="button"
            key={chip.label}
            className="slot"
            disabled={chip.amount === null || chip.amount === "0"}
            onClick={() => chip.amount !== null && setAmount(chip.amount)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {coin.status === "trading" && <LaunchFeeLine launchedAt={coin.launchedAt} />}
      {converted && sent && (
        <div className="get">
          <span className="mute">{side === "buy" ? "You pay" : "You sell"}</span>
          <span className="num">
            ≈ {compact(Number(sent))} {spendLabel}
          </span>
        </div>
      )}
      <div className="get">
        <span className="mute">You receive</span>
        <span className="num" aria-live="polite">
          {preview ? `≈ ${compact(Number(preview.received))} ${receiveLabel}` : loading ? "…" : "-"}
        </span>
      </div>
      {preview?.partial && (
        <p className="notice" style={{ marginBottom: 12 }}>
          This fills the curve. Only {compact(Number(preview.spent))} {spendLabel} is spent; the rest stays in your wallet.
        </p>
      )}
      {quoteError && (
        <p id="trade-error" className="notice err" role="alert" style={{ marginBottom: 12 }}>
          {quoteError}
        </p>
      )}
      <button
        type="button"
        className={`mbtn ${side} tb-place`}
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
      {holdings && (
        <div className="get tb-own">
          <span className="mute">You own</span>
          <span className="num">
            {compact(Number(holdings.coins))} {coin.symbol} ≈ {compact(Number(holdings.coins) * coin.priceSol)} SOL
          </span>
        </div>
      )}
      {!address && <p className="mute" style={{ fontSize: 22, marginTop: 10 }}>Use the heart button at the top to connect.</p>}
    </section>
  );
}

/**
 * During a coin's first minute: the anti-sniper fee right now and a live countdown to the 1% base,
 * so early buyers aren't surprised. "You receive" already includes it (the quote uses the
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
