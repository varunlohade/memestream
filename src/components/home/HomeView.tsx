"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { type CoinView, useCoins, usePolledTape } from "@/components/hooks";
import { useTexture, XpBar } from "@/components/pixel/Pixel";
import { StreamThumb } from "@/components/pixel/StreamThumb";
import { useSearch } from "@/components/search";
import { LivePredictions } from "./LivePredictions";
import { LiveBadge } from "@/components/ui/LiveBadge";
import { BOARD_TABS, type BoardTab, boardCoins, kingOfTheHill, lastTradeTimes } from "@/lib/board";
import { ago, formatSol, shortAddress } from "@/lib/format";

/** "Live" when the coin has a stream link and still trades on its curve; "Graduated" once on Meteora. */
function StatusTag({ coin }: { coin: CoinView }) {
  if (coin.status !== "graduated" && !coin.streamUrl) return null;
  return <LiveBadge status={coin.status} />;
}

const percentToMeteora = (coin: CoinView) => Math.floor(Math.min(Math.max(coin.progress, 0), 1) * 100);

function KingOfTheHill({ coin }: { coin: CoinView }) {
  return (
    <Link href={`/coin/${coin.mint}`} className="p koth" aria-label={`King of the hill: $${coin.symbol}`}>
      <div className="slot koth-thumb">
        <StreamThumb streamUrl={coin.streamUrl} seedKey={coin.mint} sizes="(max-width: 640px) 100vw, 240px" />
      </div>
      <div className="koth-body">
        <div className="tagrow">
          <h2 className="koth-title">King of the hill</h2>
          <StatusTag coin={coin} />
        </div>
        <p className="koth-coin">
          <b>${coin.symbol}</b> · {coin.name} · by {shortAddress(coin.creator)}
        </p>
        <p className="koth-stats num">
          market cap {formatSol(coin.marketCapSol)} SOL · {percentToMeteora(coin)}% to Meteora
        </p>
        <XpBar progress={coin.progress} small />
      </div>
    </Link>
  );
}

function CoinCard({ coin }: { coin: CoinView }) {
  return (
    <Link href={`/coin/${coin.mint}`} className="p card">
      <div className="slot card-thumb">
        <StreamThumb streamUrl={coin.streamUrl} seedKey={coin.mint} sizes="120px" />
      </div>
      <div className="card-body">
        <div className="tagrow">
          <StatusTag coin={coin} />
          <h4>${coin.symbol}</h4>
        </div>
        <p className="mute">
          by {shortAddress(coin.creator)} · {ago(coin.launchedAt)} ago
        </p>
        <p className="card-cap num">mcap {formatSol(coin.marketCapSol)} SOL</p>
        <p className="card-name">{coin.name}</p>
        <XpBar progress={coin.progress} small />
      </div>
    </Link>
  );
}

/** `predictions`: the server's MEMESTREAM_PREDICTIONS flag; with it on, the live predictions row leads the page. */
export function HomeView({ predictions = false }: { predictions?: boolean }) {
  const { data, error } = useCoins();
  const { data: tape } = usePolledTape();
  const { query } = useSearch();
  const [tab, setTab] = useState<BoardTab>("trending");
  const stone = useTexture("stone", 6);
  const all = useMemo(() => data?.coins ?? [], [data]);
  const lastTrade = useMemo(() => lastTradeTimes(tape?.items ?? []), [tape]);
  const coins = useMemo(() => boardCoins(all, tab, query, lastTrade), [all, tab, query, lastTrade]);
  const king = useMemo(() => kingOfTheHill(all), [all]);

  return (
    <div className="home">
      {predictions && <LivePredictions />}
      {king && <KingOfTheHill coin={king} />}
      <div className="sort" role="group" aria-label="Sort and filter coins">
        {(Object.keys(BOARD_TABS) as BoardTab[]).map((key) => (
          <button
            type="button"
            aria-pressed={tab === key}
            key={key}
            className={`mbtn${tab === key ? "" : " off"}`}
            style={tab === key ? stone : undefined}
            onClick={() => setTab(key)}
          >
            {BOARD_TABS[key]}
          </button>
        ))}
      </div>
      {error && <p className="notice err">{error}</p>}
      {!data && !error && <p className="notice" role="status">Loading coins</p>}
      {data && all.length === 0 && <p className="notice">No coins yet. Be the first to go live.</p>}
      {data && all.length > 0 && coins.length === 0 && <p className="notice">No coins match.</p>}
      <div className="grid">
        {coins.map((coin) => (
          <CoinCard key={coin.mint} coin={coin} />
        ))}
      </div>
    </div>
  );
}
