"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { type CoinView, useCoins } from "@/components/hooks";
import { useTexture, XpBar } from "@/components/pixel/Pixel";
import { StreamThumb } from "@/components/pixel/StreamThumb";
import { sol } from "@/lib/format";

const SORTS = {
  hot: { label: "Hot", by: (a: CoinView, b: CoinView) => b.marketCapSol - a.marketCapSol },
  new: { label: "New", by: (a: CoinView, b: CoinView) => b.launchedAt - a.launchedAt },
  close: { label: "Close to graduation", by: (a: CoinView, b: CoinView) => b.progress - a.progress },
} as const;
type SortKey = keyof typeof SORTS;

function CoinTile({ coin }: { coin: CoinView }) {
  const graduated = coin.status === "graduated";
  return (
    <Link href={`/coin/${coin.mint}`} className="p tile">
      <div className="slot thumb">
        <StreamThumb streamUrl={coin.streamUrl} seedKey={coin.mint} sizes="(max-width: 640px) 100vw, 33vw" />
        <span className="live">{graduated ? "Graduated" : "Live"}</span>
      </div>
      <div className="meta">
        <div>
          <h4>${coin.symbol}</h4>
          <p>{coin.name}</p>
        </div>
        <div style={{ textAlign: "right" }}>
          <h4 className="num">{sol(coin.marketCapSol)} SOL</h4>
          <p className="num mute">{Math.round(coin.progress * 100)}% to graduation</p>
        </div>
      </div>
      <XpBar progress={coin.progress} small />
    </Link>
  );
}

export function HomeView() {
  const { data, error } = useCoins();
  const [sort, setSort] = useState<SortKey>("hot");
  const stone = useTexture("stone", 6);
  const coins = useMemo(() => [...(data?.coins ?? [])].sort(SORTS[sort].by), [data, sort]);

  return (
    <div className="home">
      <div className="hero">
        <div>
          <h1>Live coins</h1>
          <p>Buy the stream you think will pop.</p>
        </div>
        <Link href="/go-live" className="mbtn buy hero-cta">
          Go live
        </Link>
      </div>
      <div className="sort" role="group" aria-label="Sort coins">
        {(Object.keys(SORTS) as SortKey[]).map((key) => (
          <button
            type="button"
            aria-pressed={sort === key}
            key={key}
            className={`mbtn${sort === key ? "" : " off"}`}
            style={sort === key ? stone : undefined}
            onClick={() => setSort(key)}
          >
            {SORTS[key].label}
          </button>
        ))}
      </div>
      {error && <p className="notice err">{error}</p>}
      {!data && !error && <p className="notice" role="status">Loading coins</p>}
      {data && coins.length === 0 && (
        <p className="notice">No coins yet. Be the first to go live.</p>
      )}
      <div className="grid">
        {coins.map((coin) => (
          <CoinTile key={coin.mint} coin={coin} />
        ))}
      </div>
    </div>
  );
}
