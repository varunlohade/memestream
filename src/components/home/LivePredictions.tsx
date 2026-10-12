"use client";
/** The home page's "Live predictions" row: questions open for bets across coins, like a prediction market's front page. */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useLivePredictions } from "@/components/hooks";
import { StreamThumb } from "@/components/pixel/StreamThumb";
import type { LivePrediction } from "@/lib/predictions/live";

const percent = (probability: number) => `${Math.round(probability * 100)}%`;

function countdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(sec).padStart(2, "0")}`;
}

/** A clock that follows the server's time (its `now` minus ours when the feed arrived), ticking each second. */
function useServerNow(serverNow: number | undefined) {
  const offset = useRef(0);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (serverNow !== undefined) offset.current = serverNow - Date.now();
  }, [serverNow]);
  useEffect(() => {
    const tick = () => setNow(Date.now() + offset.current);
    const timer = setInterval(tick, 1_000);
    const first = setTimeout(tick, 0);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }, []);
  return now;
}

function LiveCard({ item, now }: { item: LivePrediction; now: number | null }) {
  const href = `/coin/${item.mint}#predictions`;
  const odds = item.probability;
  const market = item.kind === "market";
  const price = (side: "yes" | "no") => (market && odds ? ` ${odds[side].toFixed(2)}` : "");
  return (
    <article className="pm-live lp-card">
      <Link href={href} className="lp-coin">
        <span className="slot lp-thumb">
          <StreamThumb streamUrl={item.streamUrl} seedKey={item.mint} sizes="64px" />
        </span>
        <b>${item.symbol}</b>
        <span className={`pm-otag ${market ? "pm-oy" : "pm-oc"} lp-kind`}>{market ? "SOL" : "points"}</span>
      </Link>
      <Link href={href} className="pm-q lp-q">
        {item.text}
      </Link>
      <div className="lp-odds num">
        <span className="up lp-pct">{odds ? percent(odds.yes) : "–"}</span> <span>Yes</span>
      </div>
      <div className="mk-bar" aria-hidden>
        <b className="mk-y" style={{ width: `${(odds?.yes ?? 0.5) * 100}%` }} />
        <b className="mk-n" style={{ width: `${(odds?.no ?? 0.5) * 100}%` }} />
      </div>
      <p className="mute pm-small num">
        {now === null ? " " : `closes in ${countdown(item.lockAt - now)}`}
        {market ? "" : " · points"}
      </p>
      <div className="lp-btns">
        <Link href={href} className="mbtn buy">
          Yes{price("yes")}
        </Link>
        <Link href={href} className="mbtn mk-no">
          No{price("no")}
        </Link>
      </div>
    </article>
  );
}

export function LivePredictions() {
  const { data } = useLivePredictions();
  const now = useServerNow(data?.now);
  if (!data) return null;
  const items = data.items.filter((item) => now === null || item.lockAt > now);
  return (
    <section className="lp" aria-label="Live predictions">
      <div className="lp-head">
        <h2>Live predictions</h2>
        {items.length > 0 && <span className="pm-livetag">Live</span>}
      </div>
      {items.length === 0 ? (
        <p className="mute lp-empty">
          No live predictions right now. Go live and ask one.{" "}
          <Link href="/go-live" className="lp-golive">
            GO LIVE
          </Link>
        </p>
      ) : (
        <div className="lp-row">
          {items.map((item) => (
            <LiveCard key={`${item.mint}:${item.id}`} item={item} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}
