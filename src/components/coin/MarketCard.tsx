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
import { DEFAULT_SLIPPAGE_BPS, SOL_DECIMALS } from "@/lib/api-types";
import { compact, fractionOf, minusReserve } from "@/lib/format";
import { postJson } from "@/lib/http";
import { profitText, resultLine, winPayout } from "@/lib/markets/payout";
import type { MarketPreview, MarketView } from "@/lib/markets/record";
import { CHALLENGE_BOND, CHALLENGE_REASON_MAX, LINK_MAX, OVERTURN_REWARD } from "@/lib/predictions/rules";
import type { MarketVerdictView } from "@/lib/predictions/view";

type Side = "yes" | "no";
type Action = "buy" | "sell";

const ODDS_POLL_MS = 5_000;
const PREVIEW_DELAY_MS = 400;
/** Price impact above this is shown in the amount box. */
const SHOW_IMPACT_ABOVE = 0.05;
/** SOL kept back on "max" buys for network fees and the new token accounts' rent. */
const SOL_RESERVE = "0.01";
const BUY_CHIPS = ["0.01", "0.05", "0.1"];
const LABEL: Record<Side, string> = { yes: "Yes", no: "No" };

/** A share pays 1 SOL if it wins, so its price is in SOL: "0.62 SOL". */
const solPrice = (price: number, decimals = 2) => `${price.toFixed(decimals)} SOL`;
const percent = (probability: number) => `${Math.round(probability * 100)}%`;
const shares = (amount: string) => compact(Number(amount));
const held = (amount: string | undefined) => Number(amount ?? 0) > 0;
/** Leftovers a sell can leave (a few millionths of a share): not shown as a position. */
const DUST_SHARES = 0.001;
const shown = (amount: string | undefined) => Number(amount ?? 0) >= DUST_SHARES;

function countdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const OUTCOME_TEXT = { yes: "YES", no: "NO", refund: "refund (every share pays 0.5 SOL)" } as const;

/** The market's odds and the wallet's position, polled while `pollMs` is set. */
export function useMarket(mint: string, predictionId: string, wallet: string | null, pollMs: number | null) {
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
    .filter((side) => shown(p[side]))
    .map((side) => `${shares(p[side])} ${side.toUpperCase()} shares · pays ${shares(p[side])} SOL if ${LABEL[side]}`);
  return parts.length ? `Your position: ${parts.join(" and ")}` : null;
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
  /** What it resolves from (the streamer's official link, or the stream), and when betting was open. */
  source?: string | null;
  betWindow?: [number, number] | null;
  /** Open the buy box on this side at once (picked from a compact row). */
  initialTicket?: Side | null;
  /** After the result: the proposal, its challenge window, and the final outcome. */
  verdict?: MarketVerdictView;
  /** The AI referee gave the result: what it saw (null when someone else gave it). */
  aiReason?: string | null;
  /** Signed in to predictions (a challenge needs the session); an admin settles challenges. */
  signedIn?: boolean;
  admin?: boolean;
  onChallenge?: (reason: string, link: string) => Promise<boolean>;
  onDecide?: (outcome: "yes" | "no" | "refund") => void;
};

export function MarketCard(props: CardProps) {
  const { mint, predictionId, text, now, canBet, poll, children, source, betWindow, verdict } = props;
  const { address, chain } = useWallet();
  const { run, locked } = useTx();
  const { market, error, refresh } = useMarket(mint, predictionId, address, poll ? ODDS_POLL_MS : null);
  const [ticket, setTicket] = useState<Side | null>(props.initialTicket ?? null);
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
  const result = market.resolved ? resultLine(market.payoutNumerators, market.position) : null;

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
      {source && (
        <p className="mute pm-small mk-src">
          Resolves from:{" "}
          <a href={source} target="_blank" rel="noopener noreferrer">
            {source}
          </a>
          {betWindow ? ` (stream window ${clock(betWindow[0])}–${clock(betWindow[1])})` : ""}
        </p>
      )}
      <div className="mk-bar" aria-hidden>
        <b className="mk-y" style={{ width: `${yes * 100}%` }} />
        <b className="mk-n" style={{ width: `${no * 100}%` }} />
      </div>
      <div className="mk-kv num">
        <span className="up">{percent(yes)} Yes</span>
        {/* Only when there is some: it counts swapped shares, so it starts at 0 and reads 0 once closed. */}
        <span className="mute">{Number(market.volumeSol) > 0 ? `Vol ${compact(Number(market.volumeSol))} SOL` : ""}</span>
        <span className="down">{percent(no)} No</span>
      </div>
      {trading && <p className="mute pm-small">Fee 0.3% per trade: 80% to the market&apos;s starting liquidity (memestream), 20% to Meteora. The streamer earns on the coin, not on markets.</p>}
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
              BUY {side.toUpperCase()} · {percent(market.probability[side])}
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
      {verdict && !market.resolved && <VerdictLine {...props} verdict={verdict} market={market} />}
      {result && (
        <div className="mk-result">
          <span className="pm-small">
            {verdict?.final ? `Final: ${OUTCOME_TEXT[verdict.final]}. ` : ""}
            {result.text}
          </span>
          {result.redeem && (
            <button type="button" className="mbtn buy" disabled={busy || locked} onClick={redeem}>
              {busy ? (status ?? "Preparing") : `Redeem #${predictionId}`}
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
  const [quote, setQuote] = useState<{ key: string; preview: MarketPreview | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!(Number(amount) > 0)) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const preview = await postJson<MarketPreview>("/api/markets/preview", { mint, predictionId, side, action, amount }, controller.signal);
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

  // Any size fills (shares are minted on demand); "max" is just what the wallet can spend.
  const maxBuy = minusReserve(market.position?.sol ?? "0", SOL_RESERVE, SOL_DECIMALS);
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
      {preview && action === "buy" && <WinLine side={side} preview={preview} />}
      {preview && (
        <div className="mk-kv num mute pm-small">
          <span>Price per share {solPrice(preview.averagePrice, 3)} (pays 1 SOL if it wins)</span>
          <span>
            {LABEL[side]} {percent(preview.probabilityAfter)} after
          </span>
        </div>
      )}
      {preview && preview.priceImpact > SHOW_IMPACT_ABOVE && (
        <p className="notice pm-small num" role="status">
          Price impact {(preview.priceImpact * 100).toFixed(1)}%: this bet moves the price a lot.
        </p>
      )}
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

/** "If YES wins, you get ≈ 0.00954 SOL (+91%)": each winning share pays 1 SOL. */
function WinLine({ side, preview }: { side: Side; preview: MarketPreview }) {
  const win = winPayout(Number(preview.spent), Number(preview.received));
  return (
    <p className="mute pm-small num">
      If {side.toUpperCase()} wins, you get ≈ {compact(win.sol)} SOL ({profitText(win.profit)})
    </p>
  );
}

const WHY: Record<NonNullable<NonNullable<MarketVerdictView>["why"]>, string> = {
  challenge: "A holder challenged it",
  unresolved: "Nobody resolved it in time",
  fallback: "The AI couldn't tell, so the streamer decided",
  ai: "The AI check disagreed with the result",
};

/** Why the AI referee couldn't tell, in plain words (admins only). */
export const AI_WHY: Record<NonNullable<NonNullable<MarketVerdictView>["aiWhy"]>, string> = {
  "no-picture": "no new picture after betting closed",
  "one-picture": "only one new picture after betting closed",
  disagree: "the pictures disagreed",
  unclear: "the pictures didn't show it",
  error: "the AI models kept failing",
  deadline: "no answer in time",
  budget: "the daily AI budget ran out",
  "no-keys": "the AI is off for this coin (no frames or no keys)",
  source: "it resolves from its official source, not the stream",
};

/**
 * The challenge window on a resolved market: "Proposed: YES · final in 1:52:10" with Challenge for
 * holders, "Disputed: under review" (admins see why and decide the outcome), or "Final: YES" until
 * it's on chain. Final on chain shows in the result line with Redeem instead.
 */
function VerdictLine(props: CardProps & { verdict: NonNullable<MarketVerdictView>; market: MarketView }) {
  const { verdict, market, now, signedIn, admin, onChallenge, onDecide } = props;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const holds = held(market.position?.yes) || held(market.position?.no);
  const proposed = OUTCOME_TEXT[verdict.proposed];
  const byAi = props.aiReason != null;

  if (verdict.status === "final") {
    return <p className="pm-small mk-verdict">Final: {verdict.final ? OUTCOME_TEXT[verdict.final] : ""}. Paying out shortly.</p>;
  }
  if (verdict.status === "disputed") {
    const c = verdict.challenge;
    return (
      <div className="mk-verdict">
        <p className="pm-small">
          <span className="pm-otag pm-oc">Disputed</span> under review
        </p>
        {admin && (
          <div className="mk-admin">
            <p className="pm-small">
              Proposed: {proposed}. {verdict.why ? WHY[verdict.why] : ""}
              {verdict.why === "fallback" && verdict.aiWhy ? ` (${AI_WHY[verdict.aiWhy]})` : ""}
              {c && <>: “{c.reason}”</>}
              {c?.link && (
                <>
                  {" "}
                  <a href={c.link} target="_blank" rel="noopener noreferrer nofollow">
                    evidence
                  </a>
                </>
              )}
            </p>
            <div className="pm-res3">
              {(["yes", "no", "refund"] as const).map((o) => (
                <button key={o} type="button" className={`mbtn ${o === "yes" ? "buy" : o === "no" ? "pm-no" : "off"}`} onClick={() => onDecide?.(o)}>
                  {o === "refund" ? "Void" : `Final ${o.toUpperCase()}`}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  const left = verdict.finalAt !== null && now !== null ? verdict.finalAt - now : null;
  const submit = async () => {
    setBusy(true);
    if (await onChallenge?.(reason, link)) setOpen(false);
    setBusy(false);
  };
  return (
    <div className="mk-verdict">
      <div className="mk-result">
        <span className="pm-small num">
          {byAi ? `AI says ${proposed}` : `Proposed: ${proposed}`}
          {left !== null ? (byAi ? ` · ${countdown(left)} to challenge` : ` · final in ${countdown(left)}`) : ""}
        </span>
        {holds && !open && (
          <button type="button" className="mbtn off" onClick={() => setOpen(true)} disabled={!signedIn} title={signedIn ? undefined : "Sign in to challenge"}>
            Challenge
          </button>
        )}
      </div>
      {byAi && props.aiReason && <p className="mute pm-small">{props.aiReason}</p>}
      {open && (
        <div className="mk-box">
          <input className="slot pm-in" placeholder="Why is the result wrong?" maxLength={CHALLENGE_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          <input className="slot pm-in" placeholder="Link to proof (optional)" maxLength={LINK_MAX} value={link} onChange={(e) => setLink(e.target.value)} aria-label="Link to proof" />
          <p className="mute pm-small">
            The bond is {CHALLENGE_BOND} points. You lose it if the result stands, get it back on a refund, and get it back plus {OVERTURN_REWARD} if the
            other side wins.
          </p>
          <div className="pm-qb">
            <button type="button" className="mbtn buy" disabled={busy || reason.trim().length === 0} onClick={submit}>
              Challenge, {CHALLENGE_BOND} points
            </button>
            <button type="button" className="mbtn off" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
