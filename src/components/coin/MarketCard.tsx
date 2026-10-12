"use client";
/**
 * A prediction's on-chain market, as card A (the Polymarket card): the question, a YES/NO bar, odds
 * and volume, two big BUY buttons, the wallet's position, and after resolution the result and
 * Redeem. Bets and redemptions go through the app's money flow (useTx().run), so the lock against
 * paying twice and the banners with Solscan links apply. The server decides everything; this only
 * shows its answers.
 */
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTx } from "@/components/tx";
import { useWallet } from "@/components/wallet/WalletProvider";
import { DEFAULT_SLIPPAGE_BPS, SOL_DECIMALS, type TradePreview } from "@/lib/api-types";
import { compact, fractionOf, minusReserve } from "@/lib/format";
import { postJson } from "@/lib/http";
import type { MarketView } from "@/lib/markets/record";

type Side = "yes" | "no";
type Action = "buy" | "sell";

const ODDS_POLL_MS = 5_000;
const PREVIEW_DELAY_MS = 400;
/** SOL kept back on "max" buys for network fees and the new token accounts' rent. */
const SOL_RESERVE = "0.01";
const BUY_CHIPS = ["0.05", "0.1"];
const LABEL: Record<Side, string> = { yes: "Yes", no: "No" };

const cents = (probability: number) => `${Math.round(probability * 100)}¢`;
const percent = (probability: number) => `${Math.round(probability * 100)}%`;
const shares = (amount: string) => compact(Number(amount));
const held = (amount: string | undefined) => Number(amount ?? 0) > 0;

function countdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The market's odds and the wallet's position, polled while `pollMs` is set. */
function useMarket(mint: string, predictionId: string, wallet: string | null, pollMs: number | null) {
  const [market, setMarket] = useState<MarketView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setMarket(await postJson<MarketView>("/api/markets/odds", { mint, predictionId, wallet }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [mint, predictionId, wallet]);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = pollMs
      ? setInterval(() => {
          if (!document.hidden) void load();
        }, pollMs)
      : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, pollMs]);
  return { market, error, refresh: load };
}

/** "Your position: 12 YES shares · pays 12 SOL if Yes", or null with nothing held. */
function positionLine(market: MarketView): string | null {
  const p = market.position;
  if (!p) return null;
  const parts = (["yes", "no"] as const)
    .filter((side) => held(p[side]))
    .map((side) => `${shares(p[side])} ${side.toUpperCase()} shares · pays ${shares(p[side])} SOL if ${LABEL[side]}`);
  return parts.length ? `Your position: ${parts.join(" and ")}` : null;
}

/** What the wallet's shares pay now that the market is resolved, and whether there's anything to redeem. */
function payout(market: MarketView): { text: string; redeem: boolean } {
  const [yes, no] = market.payoutNumerators ?? [0, 0];
  const total = yes + no || 1;
  const p = market.position;
  const sol = p ? (Number(p.yes) * yes + Number(p.no) * no) / total : 0;
  if (!p || (!held(p.yes) && !held(p.no))) return { text: "You held no shares", redeem: false };
  if (sol <= 0) return { text: "Your shares pay nothing", redeem: false };
  return { text: `Your shares pay ${compact(sol)} SOL`, redeem: true };
}

function resultTag(market: MarketView) {
  const [yes, no] = market.payoutNumerators ?? [];
  if (yes && no) return <span className="pm-otag pm-oc">Refund</span>;
  if (yes) return <span className="pm-otag pm-oy">Yes won</span>;
  return <span className="pm-otag pm-ono">No won</span>;
}

type CardProps = {
  mint: string;
  predictionId: string;
  text: string;
  /** Server time now, for the countdown. */
  now: number | null;
  /** Can this wallet bet (connected, not the streamer or a mod)? */
  canBet: boolean;
  /** Poll the odds (a live market); otherwise they're read once. */
  poll: boolean;
  /** Shown under the card (the streamer's resolve buttons, or the result's flag row). */
  children?: ReactNode;
};

export function MarketCard({ mint, predictionId, text, now, canBet, poll, children }: CardProps) {
  const { address, chain } = useWallet();
  const { run, locked } = useTx();
  const { market, error, refresh } = useMarket(mint, predictionId, address, poll ? ODDS_POLL_MS : null);
  const [ticket, setTicket] = useState<Side | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const network = chain === "solana:mainnet" ? "SOL" : "Devnet SOL";

  if (!market) {
    return (
      <div className="pm-live">
        <div className="pm-q pm-big">{text}</div>
        <p className="mute pm-small">{error ?? "Loading the market"}</p>
        {children}
      </div>
    );
  }

  const { yes, no } = market.probability;
  const trading = market.trading && (now === null || now < market.lockAt);
  const line = positionLine(market);
  const result = market.resolved ? payout(market) : null;

  const redeem = async () => {
    if (!address) return;
    setBusy(true);
    try {
      await run("market-redeem", `Redeem #${predictionId}`, { wallet: address, mint, predictionId }, (stage) => setStatus(stage));
      setStatus("Redeemed");
      await refresh();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pm-live mk">
      <div className="pm-livehead">
        {trading ? <span className="pm-livetag">Live</span> : market.resolved ? resultTag(market) : <span className="pm-otag pm-oc pm-closedtag">Closed</span>}
        <span className="mute pm-small num">
          {network}
          {trading && now !== null ? ` · closes in ${countdown(market.lockAt - now)}` : market.resolved ? "" : " · waiting for the result"}
        </span>
      </div>
      <div className="pm-q pm-big">{text}</div>
      <div className="mk-bar" aria-hidden>
        <b className="mk-y" style={{ width: `${yes * 100}%` }} />
        <b className="mk-n" style={{ width: `${no * 100}%` }} />
      </div>
      <div className="mk-kv num">
        <span className="up">{percent(yes)} Yes</span>
        <span className="mute">Vol {compact(Number(market.volumeSol))} SOL</span>
        <span className="down">{percent(no)} No</span>
      </div>
      {trading && canBet && (
        <div className="mk-big">
          {(["yes", "no"] as const).map((side) => (
            <button
              key={side}
              type="button"
              className={`mbtn ${side === "yes" ? "buy" : "mk-no"}`}
              aria-pressed={ticket === side}
              disabled={busy || locked}
              onClick={() => setTicket(ticket === side ? null : side)}
            >
              BUY {side.toUpperCase()}
              <br />
              {cents(market.probability[side])}
            </button>
          ))}
        </div>
      )}
      {trading && canBet && ticket && address && (
        <Ticket
          key={ticket}
          mint={mint}
          predictionId={predictionId}
          side={ticket}
          market={market}
          wallet={address}
          onDone={async () => {
            setTicket(null);
            await refresh();
          }}
        />
      )}
      {result && (
        <div className="mk-result">
          <span className="pm-small">{result.text}</span>
          {result.redeem && (
            <button type="button" className="mbtn buy" disabled={busy || locked} onClick={redeem}>
              {busy ? (status ?? "Preparing") : "Redeem"}
            </button>
          )}
        </div>
      )}
      {line && !result && <p className="mute pm-small num">{line}</p>}
      {status && !busy && <p className="mute pm-small">{status}</p>}
      {children}
    </div>
  );
}

/** The amount box: SOL in for a buy (or shares for a sell), chips, the preview, and Confirm. */
function Ticket({ mint, predictionId, side, market, wallet, onDone }: { mint: string; predictionId: string; side: Side; market: MarketView; wallet: string; onDone: () => Promise<void> }) {
  const { run, locked } = useTx();
  const mine = market.position?.[side] ?? "0";
  const [action, setAction] = useState<Action>("buy");
  const [amount, setAmount] = useState(BUY_CHIPS[0]);
  const [stage, setStage] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // Quote as you type (debounced); the server refuses a bet bigger than the pool's stock with its message.
  // Each answer carries the inputs it was for, so a stale one never shows.
  const key = `${action}|${amount}`;
  const [quote, setQuote] = useState<{ key: string; preview: TradePreview | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!(Number(amount) > 0)) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const preview = await postJson<TradePreview>("/api/markets/preview", { mint, predictionId, side, action, amount }, controller.signal);
        setQuote({ key, preview, error: null });
      } catch (e) {
        if (!controller.signal.aborted) setQuote({ key, preview: null, error: (e as Error).message });
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, mint, predictionId, side, action, amount]);
  const fresh = quote?.key === key && Number(amount) > 0;
  const preview = fresh ? quote.preview : null;
  const error = sendError ?? (fresh ? quote.error : null);

  const sol = market.position?.sol ?? "0";
  const affordable = minusReserve(sol, SOL_RESERVE, SOL_DECIMALS);
  const maxBuy = Number(affordable) < Number(market.maxBuySol[side]) ? affordable : market.maxBuySol[side];
  const chips: { label: string; amount: string }[] =
    action === "buy"
      ? [...BUY_CHIPS.map((c) => ({ label: c, amount: c })), { label: "max", amount: maxBuy }]
      : [
          { label: "50%", amount: fractionOf(mine, 50, SOL_DECIMALS) },
          { label: "max", amount: mine },
        ];

  const confirm = async () => {
    setSendError(null);
    try {
      const label = `${action === "buy" ? "Bet" : "Sell"} ${side.toUpperCase()} #${predictionId}`;
      const body = { wallet, mint, predictionId, side, action, amount, slippageBps: DEFAULT_SLIPPAGE_BPS, minReceived: preview?.minimumReceived };
      await run("market", label, body, (s) => setStage(s));
      setStage(null);
      await onDone();
    } catch (e) {
      setStage(null);
      setSendError((e as Error).message);
    }
  };

  const unit = action === "buy" ? "SOL" : `${side.toUpperCase()} shares`;
  return (
    <div className="mk-box">
      {held(mine) && (
        <div className="tabs" role="group" aria-label="Buy or sell">
          {(["buy", "sell"] as const).map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={action === a}
              className={`mbtn ${action === a ? (a === "buy" ? "buy" : "sell") : "off"}`}
              onClick={() => {
                setAction(a);
                setAmount(a === "buy" ? BUY_CHIPS[0] : mine);
              }}
            >
              {a === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
      )}
      <div className="slot amt num">
        <input inputMode="decimal" value={amount} onChange={(e) => {
            setSendError(null);
            setAmount(e.target.value.replace(/[^\d.]/g, ""));
          }} aria-label={`Amount in ${unit}`} />
        <small aria-hidden>{action === "buy" ? "SOL" : side.toUpperCase()}</small>
      </div>
      <div className="chips num">
        {chips.map((chip) => (
          <button type="button" key={chip.label} className="slot" disabled={!(Number(chip.amount) > 0)} onClick={() => setAmount(chip.amount)}>
            {chip.label}
          </button>
        ))}
      </div>
      <div className="get">
        <span className="mute">You get ≈</span>
        <span className="num" aria-live="polite">
          {preview ? (action === "buy" ? `${shares(preview.received)} ${side.toUpperCase()} shares` : `${compact(Number(preview.received))} SOL`) : "–"}
        </span>
      </div>
      {error && (
        <p className="notice err" role="alert">
          {error}
        </p>
      )}
      <button type="button" className={`mbtn ${side === "yes" ? "buy" : "mk-no"} mk-confirm`} disabled={!preview || locked || stage !== null} onClick={confirm}>
        {stage ?? (locked ? "Paused: checking your last trade" : "Confirm")}
      </button>
    </div>
  );
}
