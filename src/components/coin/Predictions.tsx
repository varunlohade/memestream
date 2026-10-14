"use client";
/**
 * Predictions panel (free points: no money, no prizes; points can't be bought, sold or sent).
 * Shown on the coin page only when the server's MEMESTREAM_PREDICTIONS flag is on. With
 * MEMESTREAM_MARKETS also on, each live prediction gets an on-chain market (MarketCard): its card
 * replaces the points bet box, and the points game stays for suggestions and the leaderboard.
 *
 * The wallet signs one message to start a session (its first one brings the points grant); after
 * that the session token identifies it. The streamer's own page beats once a minute (it marks them
 * "here"). The server decides everything (points, limits, who may do what); this panel only shows
 * the state and sends actions.
 */
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/components/wallet/WalletProvider";
import { shortAddress } from "@/lib/format";
import { fetchJson, postJson } from "@/lib/http";
import { newNonce, MESSAGE_TTL_MS, sessionMessage, signInInput } from "@/lib/predictions/message";
import {
  WITNESS_NOTE_MAX,
  HEARTBEAT_MS,
  MAX_LIVE,
  MIN_HOLDING_COINS,
  multiplier,
  type Outcome,
  LINK_MAX,
  QUESTION_MAX,
  type Side,
  SUGGEST_COST,
} from "@/lib/predictions/rules";
import type { LeaderRow, PredictionsView, Session, Standing } from "@/lib/predictions/view";
import bs58 from "bs58";
import { MarketCard, useMarket } from "./MarketCard";

const POLL_MS = 5_000;
/** Faster while the viewer waits on a question under review, so its approval shows within seconds. */
const REVIEW_POLL_MS = 1_500;
const CLOCK_TICK_MS = 1_000;
const SESSION_KEY = "memestream.predictions.session";
/** A saved session this close to expiry is dropped, so a request never carries a token about to lapse. */
const SESSION_EXPIRY_MARGIN_MS = 60_000;
/** Bets top out at 1,000 points, so the amount box takes at most 4 digits. */
const MAX_BET_DIGITS = 4;
const RESOLVED_SHOWN = 5;
/** How often a compact market row refreshes its odds. */
const ROW_ODDS_POLL_MS = 5_000;

/** The session lives in localStorage (a per-viewer convenience; the server checks every token). */
const savedSession = {
  get(wallet: string | null): Session | null {
    if (!wallet) return null;
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
      return s && s.wallet === wallet && s.expiresAt > Date.now() + SESSION_EXPIRY_MARGIN_MS ? s : null;
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

/** POSTs JSON with the session's auth headers. */
const postWithAuth = <T,>(url: string, body: unknown, auth: HeadersInit) =>
  fetchJson<T>(url, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });

const fmt = (n: number) => n.toLocaleString("en-US");
const sideLabel = (side: Side) => (side === "yes" ? "Yes" : "No");
/** A prediction whose on-chain market exists: its card replaces the points bet. */
const marketUp = (step: PredictionsView["live"][number]["market"]) => step === "open" || step === "closed" || step === "resolved";

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
    const timer = setInterval(tick, CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function ReviewTag() {
  return <span className="pm-otag pm-oc pm-closedtag">Under review</span>;
}

const AI_TAGS = {
  checking: ["AI checking…", "pm-oc"],
  agree: ["AI check: agrees", "pm-aiok"],
  disagree: ["AI check: disagrees", "pm-ono"],
  unclear: ["AI check: couldn't tell", "pm-oc"],
} as const;

/** The AI check's second opinion on a result; nothing if no check ran. */
function AiTag({ ai }: { ai: PredictionsView["resolved"][number]["ai"] }) {
  if (!ai) return null;
  const [text, cls] = AI_TAGS[ai];
  return <span className={`pm-otag pm-ai ${cls}`}>{text}</span>;
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
  const label = `${sideLabel(side)} ${share}%`;
  const content = (
    <>
      <b className={side === "yes" ? "pm-fy" : "pm-fn"} style={{ width: `${share}%` }} />
      <span>{label}</span>
      <span className="num">{pays ? `pays ${pays.toFixed(1)}x` : "no bets yet"}</span>
    </>
  );
  if (!onClick) return <div className="slot pm-pool num">{content}</div>;
  return (
    <button type="button" className="slot pm-pool num" onClick={onClick} disabled={disabled} aria-label={`Bet on ${sideLabel(side)}`}>
      {content}
    </button>
  );
}

export function Predictions({
  mint,
  symbol,
  streamUrl = null,
}: {
  mint: string;
  symbol: string;
  streamUrl?: string | null;
}) {
  const { address, signIn: walletSignIn } = useWallet();
  const [view, setView] = useState<PredictionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("50");
  const [question, setQuestion] = useState("");
  /** The streamer's optional official source for a real-world question (markets resolve from it). */
  const [sourceLink, setSourceLink] = useState("");
  /** The "wasn't approved" note the viewer dismissed with OK. */
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const [board, setBoard] = useState<Board>("stream");
  /** The live prediction shown open when several are live (one at a time). */
  const [openId, setOpenId] = useState<string | null>(null);
  /** The side picked on a compact row, to open its buy box at once. */
  const [openSide, setOpenSide] = useState<"yes" | "no" | null>(null);
  const now = useServerNow(view);

  // The saved session for the connected wallet (re-read after signing in or out).
  const [sessionVersion, setSessionVersion] = useState(0);
  const session = useMemo(() => (sessionVersion >= 0 ? savedSession.get(address) : null), [address, sessionVersion]);
  const setSession = (next: Session | null) => {
    savedSession.set(next);
    setSessionVersion((v) => v + 1);
  };

  const authHeaders = useCallback((): HeadersInit => (session ? { authorization: `Bearer ${session.token}` } : {}), [session]);

  const waiting = view !== null && (view.queue.some((s) => s.mine && s.status === "review") || (view.pending !== null && !view.pending.stuck));
  const pollMs = waiting ? REVIEW_POLL_MS : POLL_MS;

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
    }, pollMs);
    return () => clearInterval(timer);
  }, [mint, authHeaders, pollMs]);

  // The streamer's presence: one beat a minute while their own coin's page is visible.
  const isStreamer = Boolean(session) && view?.me?.role === "streamer";
  useEffect(() => {
    if (!isStreamer) return;
    const beat = () => {
      if (document.hidden) return;
      postWithAuth("/api/predictions/heartbeat", { mint }, authHeaders()).catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [isStreamer, authHeaders, mint]);

  const signIn = async () => {
    if (!address || !walletSignIn) return;
    setError(null);
    setBusy(true);
    try {
      const request = { domain: window.location.host, wallet: address, nonce: newNonce(), expiresAt: Date.now() + MESSAGE_TTL_MS };
      const { signedMessage, signature } = await walletSignIn(signInInput(request), new TextEncoder().encode(sessionMessage(request)));
      // The server checks the exact text the wallet signed (domain, nonce, expiry, signature).
      const message = new TextDecoder().decode(signedMessage);
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
      const next = await postWithAuth<PredictionsView | { saved: true }>(`/api/predictions/coin/${encodeURIComponent(mint)}`, body, authHeaders());
      if ("now" in next) setView(next); // else saved; the next poll shows it
      return true;
    } catch (e) {
      const message = (e as Error).message;
      if (/Sign in/.test(message)) setSession(null);
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
  const full = live.length >= MAX_LIVE;
  /** With one live prediction it is open; with several, the one tapped. */
  const openLive = live.length === 1 ? live[0].id : openId;
  const bet = Number(amount);
  /** A signed-in viewer who doesn't hold the coin: suggest and upvote stay off. */
  const notHolder = viewer && me?.holder === false;

  const headline = headlineFor(me);
  const notice = me?.notice && me.notice !== dismissedNotice ? me.notice : null;

  const suggest = async (e: FormEvent) => {
    e.preventDefault();
    if (await act({ kind: "suggest", text: question })) setQuestion("");
  };
  const launchOwn = async (e: FormEvent) => {
    e.preventDefault();
    if (await act({ kind: "launch", text: question, ...(sourceLink.trim() ? { source: sourceLink.trim() } : {}) })) {
      setQuestion("");
      setSourceLink("");
    }
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
      {notice && (
        <div className="notice err pm-notice" role="alert">
          <span>{notice}</span>
          <button type="button" className="mbtn off" onClick={() => setDismissedNotice(notice)}>
            OK
          </button>
        </div>
      )}

      {address && !session && (
        <div className="pm-signin">
          {walletSignIn ? (
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

      {live.map((p) =>
        p.id === openLive ? (
          <LiveCard
            key={p.id}
            mint={mint}
            source={p.source ?? streamUrl}
            live={p}
            now={now}
            canBet={Boolean(address) && staff === null}
            initialSide={openSide}
            viewer={viewer}
            staff={staff !== null}
            admin={me?.admin ?? false}
            busy={busy}
            amount={amount}
            onAmount={setAmount}
            onBet={(side) => act({ kind: "bet", id: p.id, side, amount: bet })}
            onResolve={(outcome) => act({ kind: "resolve", id: p.id, outcome })}
            onWitness={(outcome, note) => act({ kind: "witness", id: p.id, outcome, ...(note ? { note } : {}) })}
          />
        ) : (
          <LiveRow
            key={p.id}
            mint={mint}
            live={p}
            now={now}
            onOpen={(side) => {
              setOpenSide(side ?? null);
              setOpenId(p.id);
            }}
          />
        ),
      )}
      {view.pending ? (
        <div className="pm-row">
          <span className="pm-q">{view.pending.text}</span>
          <ReviewTag />
          {view.pending.stuck ? <StuckButtons busy={busy} onAct={(kind) => act({ kind, id: view.pending!.id })} /> : <span />}
        </div>
      ) : (
        live.length === 0 && <p className="mute pm-small">Nothing live right now.</p>
      )}

      <div className="pm-subh">
        Up next{" "}
        <span className="mute pm-small">(the streamer picks the next question)</span>
      </div>
      {view.queue.length === 0 && <p className="mute pm-small">No suggestions yet.</p>}
      {view.queueSize > view.queue.length && <p className="mute pm-small num">{view.queueSize - view.queue.length} more waiting</p>}
      {view.queue.map((s) => (
        <div className="pm-row" key={s.id}>
          <span className="pm-q">{s.text}</span>
          {s.status === "review" ? (
            <ReviewTag />
          ) : (
            <span className="mute num">
              {s.upvotes} upvote{s.upvotes === 1 ? "" : "s"}
              {s.windowMin !== null && ` · closes in ~${s.windowMin} min`}
            </span>
          )}
          {s.status === "review" ? (
            staff && s.stuck ? <StuckButtons busy={busy} onAct={(kind) => act({ kind, id: s.id })} /> : <span />
          ) : staff ? (
            <div className="pm-qb">
              <button type="button" className="mbtn buy" disabled={busy || full} onClick={() => act({ kind: "launch", id: s.id })}>
                Launch
              </button>
              <button type="button" className="mbtn off" disabled={busy} onClick={() => act({ kind: "remove", id: s.id })}>
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={`mbtn ${notHolder ? "off" : "pm-uv"}`}
              disabled={busy || !viewer || notHolder || s.mine || s.upvoted}
              onClick={() => act({ kind: "upvote", id: s.id })}
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
          <button
            type="submit"
            className={`mbtn ${!staff && notHolder ? "off" : "buy"}`}
            disabled={busy || question.trim().length === 0 || (staff !== null && (full || view.pending !== null)) || (!staff && notHolder)}
          >
            {staff ? "Launch" : `Suggest, ${SUGGEST_COST} points`}
          </button>
        </form>
      )}
      {staff && (
        <input
          className="slot pm-in pm-source"
          placeholder="Official source link for a real-world question (optional)"
          maxLength={LINK_MAX}
          value={sourceLink}
          onChange={(e) => setSourceLink(e.target.value)}
          aria-label="Official source link"
        />
      )}
      {viewer && notHolder && <p className="mute pm-small">Hold at least {MIN_HOLDING_COINS} ${symbol} to suggest and upvote.</p>}

      {view.resolved.length > 0 && <div className="pm-subh">Resolved</div>}
      {view.resolved.slice(0, RESOLVED_SHOWN).map((r) =>
        marketUp(r.market) ? (
          // Remounted when the market's step changes, so it reads the result once it's resolved.
          <MarketCard
            key={`${r.id}:${r.market}:${r.verdict?.status}`}
            mint={mint}
            predictionId={r.id}
            text={r.text}
            now={now}
            canBet={false}
            poll={false}
            source={r.source ?? streamUrl}
            betWindow={r.launchedAt !== null && r.lockAt !== null ? [r.launchedAt, r.lockAt] : null}
            verdict={r.verdict}
            aiReason={r.resolvedBy.role === "ai" ? (r.aiReason ?? "") : null}
            signedIn={Boolean(me)}
            admin={me?.admin ?? false}
            onChallenge={(reason, link) => act({ kind: "challenge", id: r.id, reason, ...(link.trim() ? { link: link.trim() } : {}) })}
            onDecide={(outcome) => void act({ kind: "decide", id: r.id, outcome })}
          >
            <ResolvedRow result={r} staff={staff !== null} busy={busy} onFlag={() => act({ kind: "flag", id: r.id })} bare />
          </MarketCard>
        ) : (
          <ResolvedRow key={r.id} result={r} staff={staff !== null} busy={busy} onFlag={() => act({ kind: "flag", id: r.id })} />
        ),
      )}

      {error && (
        <p className="notice err" role="alert">
          {error}
        </p>
      )}
      <Leaderboard board={board} top={top} mine={mine} onToggle={() => setBoard(board === "stream" ? "allTime" : "stream")} />
    </section>
  );
}

type LiveView = PredictionsView["live"][number];

/**
 * A live prediction, open: countdown, pools (tap a side to bet), and the bet box. Once betting
 * closes, the AI referee checks the stream; if it can't tell, the streamer or a mod decides. An
 * admin, the memestream oracle, may always resolve.
 */
function LiveCard(props: {
  mint: string;
  source: string | null;
  live: LiveView;
  now: number | null;
  canBet: boolean;
  initialSide?: "yes" | "no" | null;
  viewer: boolean;
  staff: boolean;
  admin: boolean;
  busy: boolean;
  amount: string;
  onAmount: (amount: string) => void;
  onBet: (side: Side) => void;
  onResolve: (outcome: Outcome) => void;
  onWitness: (outcome: Side, note: string) => void;
}) {
  const { live, now, viewer, staff, admin, busy, amount } = props;
  const locked = now !== null && now >= live.lockAt;
  const resolve = (
    <>
      {locked && <RefereeLine ai={live.ai} />}
      {locked && <WitnessLine witness={live.witness} />}
      {staff && <WitnessButtons locked={locked} decide={live.ai === "unclear"} busy={busy} onWitness={props.onWitness} />}
      {admin && !staff && locked && <ResolveButtons locked={locked} busy={busy} onResolve={props.onResolve} />}
    </>
  );
  if (marketUp(live.market)) {
    return (
      <MarketCard mint={props.mint} predictionId={live.id} text={live.text} now={now} canBet={props.canBet} poll source={props.source} betWindow={[live.launchedAt, live.lockAt]} initialTicket={props.initialSide}>
        {resolve}
      </MarketCard>
    );
  }
  if (live.market === "opening") {
    return (
      <div className="pm-live">
        <div className="pm-livehead">
          {locked ? <span className="pm-otag pm-oc pm-closedtag">Closed</span> : <span className="pm-livetag">Live</span>}
          <span className="num pm-clock">{now === null ? "" : locked ? "Betting closed" : `${countdown(live.lockAt - now)} left`}</span>
        </div>
        <div className="pm-q pm-big">{live.text}</div>
        <p className="mute pm-small">Opening market…</p>
        {resolve}
      </div>
    );
  }
  return (
    <div className="pm-live">
      <div className="pm-livehead">
        {locked ? <span className="pm-otag pm-oc pm-closedtag">Closed</span> : <span className="pm-livetag">Live</span>}
        <span className="num pm-clock">{now === null ? "" : locked ? "Betting closed" : `${countdown(live.lockAt - now)} left`}</span>
      </div>
      <div className="pm-q pm-big">{live.text}</div>
      {live.market === "failed" && <p className="mute pm-small">Market unavailable. Bet points instead.</p>}
      <div className="pm-pools">
        <SidePool side="yes" pools={live} onClick={viewer && !locked ? () => props.onBet("yes") : undefined} disabled={busy} />
        <SidePool side="no" pools={live} onClick={viewer && !locked ? () => props.onBet("no") : undefined} disabled={busy} />
      </div>
      {staff || (admin && locked) ? (
        resolve
      ) : (
        <div className="pm-bet num">
          <input
            className="slot pm-amt num"
            inputMode="numeric"
            aria-label="Points to bet"
            value={amount}
            onChange={(e) => props.onAmount(e.target.value.replace(/[^0-9]/g, "").slice(0, MAX_BET_DIGITS))}
            disabled={!viewer || locked}
          />
          <span className="mute">{locked ? "Waiting for the result" : viewer ? `Tap Yes or No to bet ${amount || 0}` : "Sign in to bet"}</span>
          <span className="r">{live.myBet ? `Your bet: ${fmt(live.myBet.amount)} on ${sideLabel(live.myBet.side)}` : ""}</span>
        </div>
      )}
      {!staff && !admin && locked && <RefereeLine ai={live.ai} />}
    </div>
  );
}

/** A live prediction, closed to one row (several are live): question, your bet, countdown and the pool split. Tap to open it. */
function LiveRow({ mint, live, now, onOpen }: { mint: string; live: LiveView; now: number | null; onOpen: (side?: "yes" | "no") => void }) {
  const locked = now !== null && now >= live.lockAt;
  const total = live.yes + live.no;
  const yes = total > 0 ? Math.round((live.yes / total) * 100) : 0;
  return (
    <div
      className="pm-row"
      role="button"
      tabIndex={0}
      aria-expanded={false}
      onClick={() => onOpen()}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen();
      }}
    >
      <span className="pm-q">
        {live.text}
        {live.myBet && <span className="mute pm-by"> Your bet: {fmt(live.myBet.amount)} on {sideLabel(live.myBet.side)}</span>}
      </span>
      <span className="mute num">{now === null ? "" : locked ? "Closed" : `${countdown(live.lockAt - now)} left`}</span>
      {live.market && live.market !== "failed" ? (
        live.market === "opening" || locked ? (
          <span className="mute pm-small">{locked ? "Betting closed" : "Opening market…"}</span>
        ) : (
          <RowOdds mint={mint} predictionId={live.id} onPick={(side) => onOpen(side)} />
        )
      ) : (
        <div className="slot pm-pool num">
          <b className="pm-fy" style={{ width: `${yes}%` }} />
          <span>Yes {yes}%</span>
          <span>No {total > 0 ? 100 - yes : 0}%</span>
        </div>
      )}
    </div>
  );
}

/** A market row's odds with its own Yes / No buttons, so several live markets can be traded from the list. */
function RowOdds({ mint, predictionId, onPick }: { mint: string; predictionId: string; onPick: (side: "yes" | "no") => void }) {
  const { market } = useMarket(mint, predictionId, null, ROW_ODDS_POLL_MS);
  const pct = (side: "yes" | "no") => (market ? `${Math.round(market.probability[side] * 100)}%` : "…");
  const pick = (side: "yes" | "no") => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onPick(side);
  };
  return (
    <div className="pm-qb">
      <button type="button" className="mbtn buy" onClick={pick("yes")}>
        YES {pct("yes")}
      </button>
      <button type="button" className="mbtn pm-no" onClick={pick("no")}>
        NO {pct("no")}
      </button>
    </div>
  );
}

function ordinal(n: number) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return "th";
  return ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
}

function headlineFor(me: PredictionsView["me"]) {
  if (me?.role === "streamer") return "You can't bet on your own coin";
  if (me?.role === "mod") return "Mods can't bet on this coin";
  return me ? `Your points: ${fmt(me.balance)}` : "";
}

/** A question every review check failed on: staff approve or remove it by hand. */
function StuckButtons({ busy, onAct }: { busy: boolean; onAct: (kind: "approve" | "remove") => void }) {
  return (
    <div className="pm-qb">
      <button type="button" className="mbtn buy" disabled={busy} onClick={() => onAct("approve")}>
        Approve
      </button>
      <button type="button" className="mbtn off" disabled={busy} onClick={() => onAct("remove")}>
        Remove
      </button>
    </div>
  );
}

const RESOLVE_LABELS: Record<Outcome, string> = { yes: "Resolve Yes", no: "Resolve No", cancel: "Cancel" };
/** After betting closes: Yes green, No red, Cancel off. */
const RESOLVE_CLASSES: Record<Outcome, string> = { yes: "buy", no: "pm-no", cancel: "off" };

/** What the streamer or a mod said happened, shown under a closed prediction. */
function WitnessLine({ witness }: { witness: LiveView["witness"] }) {
  if (!witness) return null;
  return (
    <p className="mute pm-small">
      The {witness.role} says: <strong>{witness.outcome === "yes" ? "Yes" : "No"}</strong>
      {witness.note ? ` · "${witness.note}"` : ""}
    </p>
  );
}

/** Where the result stands once betting closed: the AI referee checking, or the streamer deciding. */
function RefereeLine({ ai }: { ai: LiveView["ai"] }) {
  if (ai === "checking") return <p className="mute pm-small">AI is checking the stream…</p>;
  if (ai === "unclear") return <p className="mute pm-small">AI couldn&apos;t tell. The streamer decides.</p>;
  return null;
}

/** Staff decide only when the AI referee couldn't tell (`decide`): YES or NO, with an optional note. */
function WitnessButtons(props: { locked: boolean; decide: boolean; busy: boolean; onWitness: (outcome: Side, note: string) => void }) {
  const { locked, decide, busy, onWitness } = props;
  const [note, setNote] = useState("");
  if (!locked) return <p className="mute pm-small">When betting closes, the AI checks the stream. If it can&apos;t tell, you decide.</p>;
  if (!decide) return null;
  return (
    <div>
      <input className="slot pm-amt" style={{ width: "100%", marginBottom: 8 }} placeholder="Optional note (what the stream showed)" maxLength={WITNESS_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
      <div className="pm-res3">
        {(["yes", "no"] as const).map((side) => (
          <button key={side} type="button" className={`mbtn ${RESOLVE_CLASSES[side]}`} disabled={busy} onClick={() => onWitness(side, note.trim())}>
            {side === "yes" ? "Decide: YES" : "Decide: NO"}
          </button>
        ))}
      </div>
    </div>
  );
}

function ResolveButtons({ locked, busy, onResolve }: { locked: boolean; busy: boolean; onResolve: (outcome: Outcome) => void }) {
  return (
    <div className="pm-res3">
      {(["yes", "no", "cancel"] as const).map((outcome) => (
        <button
          key={outcome}
          type="button"
          // While betting is open all three look off.
          className={`mbtn ${locked ? RESOLVE_CLASSES[outcome] : "off"}`}
          disabled={busy || !locked}
          onClick={() => onResolve(outcome)}
        >
          {RESOLVE_LABELS[outcome]}
        </button>
      ))}
    </div>
  );
}

type ResolvedResult = PredictionsView["resolved"][number];

/** The viewer's own result on a resolved prediction, or null if they didn't bet. */
function betOutcome(my: ResolvedResult["my"], outcome: Outcome) {
  if (!my) return null;
  if (outcome === "cancel" || my.payout === my.bet) return { text: "Refunded", cls: "mute" };
  if (my.payout > my.bet) return { text: `You won ${fmt(my.payout - my.bet)}`, cls: "up" };
  return { text: `You lost ${fmt(my.bet - my.payout)}`, cls: "mute" };
}

/** `bare`: inside its market's card, which already shows the question and the result. */
function ResolvedRow({ result: r, staff, busy, onFlag, bare = false }: { result: ResolvedResult; staff: boolean; busy: boolean; onFlag: () => void; bare?: boolean }) {
  const result = betOutcome(r.my, r.outcome);
  const { role, wallet } = r.resolvedBy;
  const by = role === "auto" ? "auto-cancelled" : role === "ai" ? "AI referee" : role === "admin" ? "memestream oracle" : wallet ? `${role} ${shortAddress(wallet)}` : role;
  const at = new Date(r.resolvedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="pm-rr num">
      <span className="pm-q" title={`Resolved ${at} by ${by}`}>
        {!bare && r.text}
        <span className="mute pm-by">
          {bare ? `Resolved ${at}, ${by}` : ` ${at}, ${by}`}
        </span>
        <AiTag ai={r.ai} />
      </span>
      <OutcomeTag outcome={r.outcome} />
      {r.disputed ? <span className="pm-otag pm-oc pm-dsp">Disputed</span> : <span />}
      <span className={`r ${result?.cls ?? ""}`}>{staff ? "" : (result?.text ?? "")}</span>
      {!staff && r.my && !r.my.flagged && r.my.canFlag ? (
        <button type="button" className="pm-flag" disabled={busy} onClick={onFlag} title="Flag a wrong result">
          Flag
        </button>
      ) : (
        <span className="pm-flag mute">{r.my?.flagged ? "Flagged" : ""}</span>
      )}
      {!bare && role === "ai" && r.aiReason && (
        <span className="mute pm-small" style={{ gridColumn: "1 / -1" }}>
          AI saw: {r.aiReason}
        </span>
      )}
      {r.witness && r.verdict && r.verdict.status !== "final" && (
        <span className="mute pm-small" style={{ gridColumn: "1 / -1" }}>
          The {r.witness.role} says: {r.witness.outcome === "yes" ? "Yes" : "No"}
          {r.witness.note ? ` · "${r.witness.note}"` : ""}
        </span>
      )}
    </div>
  );
}

type Board = keyof PredictionsView["leaderboard"]["me"];
type LeaderboardProps = { board: Board; top: LeaderRow[]; mine: Standing | null; onToggle: () => void };

function Leaderboard({ board, top, mine, onToggle }: LeaderboardProps) {
  return (
    <div className="pm-lb num">
      <button type="button" className="pm-lbtoggle mute" onClick={onToggle} title="Switch leaderboard">
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
  );
}
