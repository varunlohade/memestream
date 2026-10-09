"use client";
/**
 * Predictions panel (free points only: no money, no prizes; points can't be bought, sold or sent).
 * Shown on the coin page only when the server's MEMESTREAM_PREDICTIONS flag is on.
 *
 * The wallet signs one message to start a session; after that the session token identifies it.
 * While the page is visible, a heartbeat every 60 s earns watch points. The server decides
 * everything (points, limits, who may do what); this panel only shows the state and sends actions.
 */
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/components/wallet/WalletProvider";
import { shortAddress } from "@/lib/format";
import { fetchJson, postJson } from "@/lib/http";
import { newNonce, MESSAGE_TTL_MS, sessionMessage } from "@/lib/predictions/message";
import { BET_WINDOWS_MIN, DEFAULT_WINDOW_MIN, HEARTBEAT_MS, multiplier, type Outcome, QUESTION_MAX, type Side, SUGGEST_COST } from "@/lib/predictions/rules";
import type { PredictionsView, Session } from "@/lib/predictions/view";
import bs58 from "bs58";

const POLL_MS = 5_000;
const SESSION_KEY = "memestream.predictions.session";

/** The session lives in localStorage (a per-viewer convenience; the server checks every token). */
const savedSession = {
  get(wallet: string | null): Session | null {
    if (!wallet) return null;
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
      return s && s.wallet === wallet && s.expiresAt > Date.now() + 60_000 ? s : null;
    } catch {
      return null;
    }
  },
  set(session: Session | null) {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      // storage blocked: the viewer signs in again next time
    }
  },
};

const fmt = (n: number) => n.toLocaleString("en-US");

function countdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A clock that follows the server's time (its `now` minus ours when the view arrived). */
function useServerNow(view: PredictionsView | null) {
  const offset = useRef(0);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (view) offset.current = view.now - Date.now();
  }, [view]);
  useEffect(() => {
    const tick = () => setNow(Date.now() + offset.current);
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function OutcomeTag({ outcome }: { outcome: Outcome }) {
  if (outcome === "yes") return <span className="pm-otag pm-oy">Yes</span>;
  if (outcome === "no") return <span className="pm-otag pm-ono">No</span>;
  return <span className="pm-otag pm-oc">Cancelled</span>;
}

function SidePool({ side, pools, onClick, disabled }: { side: Side; pools: { yes: number; no: number }; onClick?: () => void; disabled?: boolean }) {
  const total = pools.yes + pools.no;
  const share = total > 0 ? Math.round((pools[side] / total) * 100) : 0;
  const pays = multiplier(side, pools);
  const label = `${side === "yes" ? "Yes" : "No"} ${share}%`;
  const content = (
    <>
      <b className={side === "yes" ? "pm-fy" : "pm-fn"} style={{ width: `${share}%` }} />
      <span>{label}</span>
      <span className="num">{pays ? `pays ${pays.toFixed(1)}x` : "no bets yet"}</span>
    </>
  );
  if (!onClick) return <div className="slot pm-pool num">{content}</div>;
  return (
    <button type="button" className="slot pm-pool num" onClick={onClick} disabled={disabled} aria-label={`Bet on ${side === "yes" ? "Yes" : "No"}`}>
      {content}
    </button>
  );
}

export function Predictions({ mint, symbol }: { mint: string; symbol: string }) {
  const { address, signMessage } = useWallet();
  const [view, setView] = useState<PredictionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("50");
  const [question, setQuestion] = useState("");
  const [windowMin, setWindowMin] = useState<number>(DEFAULT_WINDOW_MIN);
  const [board, setBoard] = useState<"stream" | "allTime">("stream");
  const now = useServerNow(view);

  // The saved session for the connected wallet (re-read after signing in or out).
  const [sessionVersion, setSessionVersion] = useState(0);
  const session = useMemo(() => (sessionVersion >= 0 ? savedSession.get(address) : null), [address, sessionVersion]);
  const setSession = (next: Session | null) => {
    savedSession.set(next);
    setSessionVersion((v) => v + 1);
  };

  const authHeaders = useCallback((): HeadersInit => (session ? { authorization: `Bearer ${session.token}` } : {}), [session]);

  // Poll the coin's predictions while the tab is visible.
  useEffect(() => {
    const load = async () => {
      try {
        setView(await fetchJson<PredictionsView>(`/api/predictions/coin/${encodeURIComponent(mint)}`, { headers: authHeaders() }));
      } catch (e) {
        setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [mint, authHeaders]);

  // Watch points: one heartbeat a minute while this page is visible (the server ignores faster ones).
  useEffect(() => {
    if (!session) return;
    const beat = () => {
      if (document.hidden) return;
      fetchJson("/api/predictions/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ mint }),
      }).catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [session, authHeaders, mint]);

  const signIn = async () => {
    if (!address || !signMessage) return;
    setError(null);
    setBusy(true);
    try {
      const message = sessionMessage({ domain: window.location.host, wallet: address, nonce: newNonce(), expiresAt: Date.now() + MESSAGE_TTL_MS });
      const signature = await signMessage(new TextEncoder().encode(message));
      const next = await postJson<Session>("/api/predictions/session", { message, signature: bs58.encode(signature) });
      setSession(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (body: Record<string, unknown>) => {
    setError(null);
    setBusy(true);
    try {
      const next = await fetchJson<PredictionsView>(`/api/predictions/coin/${encodeURIComponent(mint)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      setView(next);
      return true;
    } catch (e) {
      const message = (e as Error).message;
      if (/Sign in/.test(message)) {
        setSession(null);
      }
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <section className="p pm" aria-label="Predictions">
        <div className="pm-head">
          <h2>Predictions</h2>
        </div>
        <p className="mute pm-small">{error ?? "Loading predictions"}</p>
      </section>
    );
  }

  const me = session ? view.me : null;
  const staff = me?.role ?? null;
  const viewer = Boolean(me) && !staff;
  const live = view.live;
  const locked = live !== null && now !== null && now >= live.lockAt;
  const bet = Number(amount);

  const headline = staff
    ? staff === "streamer"
      ? "You can't bet on your own coin"
      : "Mods can't bet on this coin"
    : me
      ? `Your points ${fmt(me.balance)}. You earn points by watching.`
      : "You earn points by watching.";

  const suggest = async (e: FormEvent) => {
    e.preventDefault();
    if (await act({ kind: "suggest", text: question })) setQuestion("");
  };
  const launchOwn = async (e: FormEvent) => {
    e.preventDefault();
    if (await act({ kind: "launch", text: question, windowMin })) setQuestion("");
  };

  const standings = view.leaderboard;
  const top = standings[board];
  const mine = me && !staff ? standings.me[board] : null;

  return (
    <section className="p pm" aria-label="Predictions">
      <div className="pm-head">
        <h2>Predictions</h2>
        <span className="mute num">{headline}</span>
      </div>

      {address && !session && (
        <div className="pm-signin">
          {signMessage ? (
            <button type="button" className="mbtn buy" onClick={signIn} disabled={busy}>
              {busy ? "Check your wallet" : "Sign in to play"}
            </button>
          ) : (
            <p className="mute pm-small">This wallet can&apos;t sign messages, so it can&apos;t play predictions.</p>
          )}
          <p className="mute pm-small">One signature, free. It sends nothing.</p>
        </div>
      )}
      {!address && <p className="mute pm-small">Connect a wallet to play.</p>}
      {me && !staff && me.starterInMinutes !== null && (
        <p className="mute pm-small num">Watch {me.starterInMinutes} more minutes for 200 starter points.</p>
      )}

      {live ? (
        <div className="pm-live">
          <div className="pm-livehead">
            <span className="pm-livetag">Live</span>
            <span className="num pm-clock">{now === null ? "" : locked ? "Betting closed" : `${countdown(live.lockAt - now)} left`}</span>
          </div>
          <div className="pm-q pm-big">{live.text}</div>
          <div className="pm-pools">
            <SidePool side="yes" pools={live} onClick={viewer && !locked ? () => act({ kind: "bet", side: "yes", amount: bet }) : undefined} disabled={busy} />
            <SidePool side="no" pools={live} onClick={viewer && !locked ? () => act({ kind: "bet", side: "no", amount: bet }) : undefined} disabled={busy} />
          </div>
          {staff ? (
            <div className="pm-res3">
              {(["yes", "no", "cancel"] as const).map((outcome) => (
                <button
                  key={outcome}
                  type="button"
                  // While betting is open all three look off; after the close: Yes green, No red, Cancel off.
                  className={`mbtn ${!locked ? "off" : outcome === "yes" ? "buy" : outcome === "no" ? "pm-no" : "off"}`}
                  disabled={busy || !locked}
                  onClick={() => act({ kind: "resolve", outcome })}
                >
                  {outcome === "yes" ? "Resolve Yes" : outcome === "no" ? "Resolve No" : "Cancel"}
                </button>
              ))}
            </div>
          ) : (
            <div className="pm-bet num">
              <input
                className="slot pm-amt num"
                inputMode="numeric"
                aria-label="Points to bet"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
                disabled={!viewer || locked}
              />
              <span className="mute">{locked ? "Waiting for the result" : viewer ? `Tap Yes or No to bet ${amount || 0}` : "Sign in to bet"}</span>
              <span className="r">{live.myBet ? `Your bet: ${fmt(live.myBet.amount)} on ${live.myBet.side === "yes" ? "Yes" : "No"}` : ""}</span>
            </div>
          )}
          {staff && !locked && <p className="mute pm-small">Resolve once betting closes.</p>}
        </div>
      ) : (
        <p className="mute pm-small">Nothing live right now.</p>
      )}

      <div className="pm-subh">
        Up next{" "}
        <span className="mute pm-small">
          {!view.crowdPicks
            ? "(the streamer picks the next question)"
            : view.streamerHere
              ? "(the top question with 3 or more upvotes goes live next)"
              : "(questions wait until the streamer is here)"}
        </span>
      </div>
      {staff && (
        <div className="pm-window">
          <span className="mute">Window</span>
          {BET_WINDOWS_MIN.map((m) => (
            <button key={m} type="button" className={`slot pm-chip${windowMin === m ? " on" : ""}`} onClick={() => setWindowMin(m)} aria-pressed={windowMin === m}>
              {m}m
            </button>
          ))}
          <button
            type="button"
            className={`slot pm-crowd${view.crowdPicks ? " on" : ""}`}
            onClick={() => act({ kind: "crowd", on: !view.crowdPicks })}
            disabled={busy}
            aria-pressed={view.crowdPicks}
          >
            Crowd picks questions: {view.crowdPicks ? "on" : "off"}
          </button>
        </div>
      )}
      {view.queue.length === 0 && <p className="mute pm-small">No suggestions yet.</p>}
      {view.queueSize > view.queue.length && <p className="mute pm-small num">{view.queueSize - view.queue.length} more waiting</p>}
      {view.queue.map((s) => (
        <div className="pm-row" key={s.id}>
          <span className="pm-q">{s.text}</span>
          <span className="mute num">
            {s.upvotes} upvote{s.upvotes === 1 ? "" : "s"}
          </span>
          {staff ? (
            <div className="pm-qb">
              <button type="button" className="mbtn buy" disabled={busy || Boolean(live)} onClick={() => act({ kind: "launch", id: s.id, windowMin })}>
                Launch
              </button>
              <button type="button" className="mbtn off" disabled={busy} onClick={() => act({ kind: "remove", id: s.id })}>
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="mbtn pm-uv"
              disabled={busy || !viewer || s.mine || s.upvoted}
              onClick={() => act({ kind: "upvote", id: s.id })}
              title={me && !me.eligible ? "Watch 15 minutes to upvote" : undefined}
            >
              {s.upvoted ? "Upvoted" : s.mine ? "Yours" : "Upvote"}
            </button>
          )}
        </div>
      ))}
      {(viewer || staff) && (
        <form className="pm-ask" onSubmit={staff ? launchOwn : suggest}>
          <input
            className="slot pm-in"
            placeholder={staff ? "Ask your own yes/no question" : "Suggest a yes/no question"}
            maxLength={QUESTION_MAX}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            aria-label={staff ? "Your question" : "Suggest a question"}
          />
          <button type="submit" className="mbtn buy" disabled={busy || question.trim().length === 0 || (staff !== null && Boolean(live))}>
            {staff ? "Launch" : `Suggest, ${SUGGEST_COST} points`}
          </button>
        </form>
      )}
      {viewer && <p className="mute pm-small">Hold ${symbol} to suggest and upvote.</p>}

      {view.resolved.length > 0 && <div className="pm-subh">Resolved</div>}
      {view.resolved.slice(0, 5).map((r) => {
        const result = r.my
          ? r.outcome === "cancel" || r.my.payout === r.my.bet
            ? { text: "Refunded", cls: "mute" }
            : r.my.payout > r.my.bet
              ? { text: `You won ${fmt(r.my.payout - r.my.bet)}`, cls: "up" }
              : { text: `You lost ${fmt(r.my.bet - r.my.payout)}`, cls: "mute" }
          : null;
        const by = r.resolvedBy.role === "auto" ? "auto-cancelled" : `${r.resolvedBy.role} ${shortAddress(r.resolvedBy.wallet ?? "")}`;
        const at = new Date(r.resolvedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return (
          <div className="pm-rr num" key={r.id}>
            <span className="pm-q" title={`Resolved ${at} by ${by}`}>
              {r.text}
              <span className="mute pm-by">
                {" "}
                {at}, {by}
              </span>
            </span>
            <OutcomeTag outcome={r.outcome} />
            {r.disputed ? <span className="pm-otag pm-oc pm-dsp">Disputed</span> : <span />}
            <span className={`r ${result?.cls ?? ""}`}>{staff ? "" : (result?.text ?? "")}</span>
            {!staff && r.my && !r.my.flagged && r.my.canFlag ? (
              <button type="button" className="pm-flag" disabled={busy} onClick={() => act({ kind: "flag", id: r.id })} title="Flag a wrong result">
                Flag
              </button>
            ) : (
              <span className="pm-flag mute">{r.my?.flagged ? "Flagged" : ""}</span>
            )}
          </div>
        );
      })}

      {error && (
        <p className="notice err" role="alert">
          {error}
        </p>
      )}
      <p className="pm-free">Free points. No money, no prizes.</p>
      <div className="pm-lb num">
        <button type="button" className="pm-lbtoggle mute" onClick={() => setBoard(board === "stream" ? "allTime" : "stream")} title="Switch leaderboard">
          {board === "stream" ? "Top points" : "All time"}
        </button>
        {top.length === 0 && <span className="mute">No winners yet</span>}
        {top.map((l, i) => (
          <span key={l.wallet}>
            {i > 0 && <i className="pm-sep" />}
            {i + 1} {shortAddress(l.wallet)} {fmt(l.points)}
          </span>
        ))}
        {mine && (
          <span className="up">
            {top.length > 0 && <i className="pm-sep" />}
            You {fmt(mine.points)}
            {mine.rank ? `, ${mine.rank}${ordinal(mine.rank)}` : ""}
          </span>
        )}
      </div>
    </section>
  );
}

function ordinal(n: number) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return "th";
  return ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
}
