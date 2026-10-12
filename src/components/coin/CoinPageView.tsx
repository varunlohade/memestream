"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { type CoinDetail, type CoinView, type HolderView, type Holdings, type TradeView, useCoin, useHolders, usePriceTrend } from "@/components/hooks";
import { useTx } from "@/components/tx";
import { noSubscription } from "@/components/no-subscription";
import { useHostname } from "@/components/use-hostname";
import { Scene, useTexture, XpBar } from "@/components/pixel/Pixel";
import { StreamThumb } from "@/components/pixel/StreamThumb";
import { LiveBadge } from "@/components/ui/LiveBadge";
import { UnverifiedTag } from "@/components/UnverifiedTag";
import { useWallet } from "@/components/wallet/WalletProvider";
import { ago, compact, formatSol, shortAddress, SIDE_LABEL, signedPercent } from "@/lib/format";
import { solscanAccount, solscanTx } from "@/lib/explorer";
import { priceSeries } from "@/lib/price-series";
import { parseStreamLink } from "@/lib/stream-link";
import { Predictions } from "./Predictions";
import { PriceChart } from "./PriceChart";
import { TradeBox } from "./TradeBox";

function StreamEmbed({ coin }: { coin: CoinView }) {
  const host = useHostname();
  const link = coin.streamUrl ? parseStreamLink(coin.streamUrl) : null;
  return (
    <div className="embed">
      {link && host ? (
        <iframe
          src={link.embedUrl(host)}
          title={`${coin.name} live stream`}
          allow="autoplay; fullscreen"
          style={{ width: "100%", height: "100%", border: 0, display: "block" }}
        />
      ) : (
        <Scene seedKey={coin.mint} width={192} height={108} />
      )}
      <LiveBadge status={coin.status} />
    </div>
  );
}

/** A graduated coin trades in its Meteora pool: say so, with links to the pool (and Jupiter on mainnet). */
function MeteoraNote({ coin }: { coin: CoinView }) {
  const { chain } = useWallet();
  if (!coin.meteoraPool) return null;
  return (
    <p className="mute meteora-note">
      Graduated: trades in its Meteora pool.{" "}
      <a href={solscanAccount(coin.meteoraPool, chain)} target="_blank" rel="noopener noreferrer">
        View pool
      </a>
      {chain === "solana:mainnet" && (
        <>
          {" · "}
          <a href={`https://jup.ag/swap/SOL-${coin.mint}`} target="_blank" rel="noopener noreferrer">
            Jupiter
          </a>
        </>
      )}
    </p>
  );
}

function TradeList({ trades, symbol }: { trades: TradeView[]; symbol: string }) {
  const { chain } = useWallet();
  // "3d ago" depends on the clock: render it after hydration, so server and browser HTML match.
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  if (trades.length === 0) return <p className="mute" style={{ fontSize: 24 }}>No trades yet.</p>;
  return (
    <ul className="trade-list">
      {trades.map((t) => (
        <li className="tr num" key={t.signature}>
          <span className={t.side === "buy" ? "up" : "down"}>{SIDE_LABEL[t.side]}</span>
          <span>{formatSol(t.sol)} SOL</span>
          <span>
            {compact(Number(t.coins))} {symbol}
          </span>
          <span className="mute">
            {shortAddress(t.wallet)}
            {t.byStreamer && <b className="tag">streamer</b>}
          </span>
          <a className="r mute" href={solscanTx(t.signature, chain)} target="_blank" rel="noopener noreferrer" title="View on Solscan">
            {hydrated && (
              <>
                {ago(t.time)}
                <span className="ago"> ago</span>
              </>
            )}{" "}
            ↗
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Claim (for the streamer), Graduate (for anyone, once the curve is full), and after graduation
 * Claim pool fees (for whoever holds an LP position NFT in the coin's Meteora pool).
 */
function CoinActions({ coin, holdings, onDone }: { coin: CoinView; holdings: Holdings | null; onDone: () => void }) {
  const { address } = useWallet();
  const { run: runTx, locked } = useTx();
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  /** The running action and its stage ("Check your wallet"...), shown on that action's button only. */
  const [running, setRunning] = useState<{ action: string; stage: string } | null>(null);
  const stage = running?.stage ?? null;
  const labelFor = (action: string, idle: string) => (running?.action === action ? running.stage : idle);
  const isStreamer = address === coin.creator;
  const canClaim = isStreamer && Number(coin.streamerUnclaimedSol) > 0;
  const canGraduate = coin.status === "graduating" && Boolean(address);
  const lpFees = holdings?.lpFees ?? null;
  const canClaimLp = Boolean(lpFees) && (Number(lpFees?.sol) > 0 || Number(lpFees?.coins) > 0);
  if (!isStreamer && !canGraduate && !lpFees) return null;

  const ACTION_LABEL = { claim: "Claim", graduate: "Graduate", "claim-lp": "Claim pool fees" } as const;
  const runAction = async (action: keyof typeof ACTION_LABEL, successText: string) => {
    if (!address) return;
    setStatus(null);
    try {
      await runTx(action, `${ACTION_LABEL[action]} ${coin.symbol}`, { wallet: address, mint: coin.mint }, (next) => setRunning({ action, stage: next }));
      setStatus({ error: false, text: successText });
      onDone();
    } catch (e) {
      setStatus({ error: true, text: (e as Error).message });
    } finally {
      setRunning(null);
    }
  };

  return (
    <section className="p" aria-label="Coin actions" style={{ display: "grid", gap: 12 }}>
      {isStreamer && (
        <>
          <div className="lbl mute">Your earnings</div>
          <div className="cap num" style={{ fontSize: 34 }}>{formatSol(coin.streamerUnclaimedSol)} SOL</div>
          <button type="button" className="mbtn buy" disabled={!canClaim || Boolean(stage) || Boolean(locked)} onClick={() => runAction("claim", "Earnings sent to your wallet")}>
            {labelFor("claim", "Claim earnings")}
          </button>
        </>
      )}
      {lpFees && (
        <>
          <div className="lbl mute">Your LP NFT: pool fees (the liquidity stays locked)</div>
          <div className="cap num" style={{ fontSize: 34 }}>
            {formatSol(lpFees.sol)} SOL
            {Number(lpFees.coins) > 0 && <span className="mute"> + {compact(Number(lpFees.coins))} {coin.symbol}</span>}
          </div>
          <button type="button" className="mbtn buy" disabled={!canClaimLp || Boolean(stage) || Boolean(locked)} onClick={() => runAction("claim-lp", "Pool fees sent to your wallet")}>
            {labelFor("claim-lp", "Claim pool fees")}
          </button>
        </>
      )}
      {canGraduate && (
        <button type="button" className="mbtn buy" disabled={Boolean(stage) || Boolean(locked)} onClick={() => runAction("graduate", "Graduated to Meteora")}>
          {labelFor("graduate", "Graduate to Meteora")}
        </button>
      )}
      {status && (
        <p className={`notice${status.error ? " err" : ""}`} role={status.error ? "alert" : "status"}>
          {status.text}
        </p>
      )}
    </section>
  );
}

type CoinTab = "trades" | "predictions" | "holders";

const HOLDER_ROLE_LABEL = { curve: "bonding curve", pool: "Meteora pool", streamer: "streamer" } as const;

/** Who holds the coin: owners linked to Solscan, with the curve or pool vault and the streamer named. */
function HolderList({ holders, limit }: { holders: HolderView[] | null; limit?: number }) {
  const { chain } = useWallet();
  if (!holders) return <p className="mute holders-empty">Loading holders</p>;
  if (holders.length === 0) return <p className="mute holders-empty">No holders yet.</p>;
  return (
    <ol className="holder-list num">
      {holders.slice(0, limit).map((h, i) => (
        <li key={h.owner}>
          <span>
            {i + 1}.{" "}
            <a href={solscanAccount(h.owner, chain)} target="_blank" rel="noopener noreferrer">
              {h.role === "curve" || h.role === "pool" ? HOLDER_ROLE_LABEL[h.role] : shortAddress(h.owner)}
            </a>
            {h.role === "streamer" && <span className="mute"> (streamer)</span>}
          </span>
          <span>{h.percent.toFixed(1)}%</span>
        </li>
      ))}
    </ol>
  );
}

/** How far the curve is, what's left to raise; after graduation, where the coin trades now. */
function CurveProgress({ coin }: { coin: CoinView }) {
  const graduated = coin.status === "graduated";
  const percent = Math.floor(Math.min(Math.max(coin.progress, 0), 1) * 100);
  const left = Math.max(0, Number(coin.thresholdSol) - Number(coin.raisedSol));
  return (
    <section className="p curve" aria-label="Bonding curve progress">
      <div className="curve-head">
        <h2>bonding curve progress</h2>
        <span className="num up">{graduated ? "Graduated" : `${percent}%`}</span>
      </div>
      <XpBar progress={coin.progress} small />
      {graduated ? (
        <MeteoraNote coin={coin} />
      ) : (
        <p className="mute curve-note">
          {coin.status === "graduating" ? "The curve is full." : `${formatSol(left)} SOL left until this coin graduates to a Meteora pool.`} 80% of
          fees go to the streamer.
        </p>
      )}
    </section>
  );
}

/**
 * `initial` is rendered by the server; polling keeps it fresh and adds the wallet's holdings.
 * `predictions`: the server's MEMESTREAM_PREDICTIONS flag (free-points panel); off by default.
 */
export function CoinPageView({
  mint,
  initial,
  predictions = false,
  network = { label: "Devnet", test: true },
  markets = false,
}: {
  mint: string;
  initial: CoinDetail;
  predictions?: boolean;
  /** The server's network label, and whether its SOL is test money (not mainnet). */
  network?: { label: string; test: boolean };
  markets?: boolean;
}) {
  const { address } = useWallet();
  const { data, refresh } = useCoin(mint, address, initial);
  const detail = data ?? initial;
  const { change } = usePriceTrend(detail);
  const points = useMemo(() => priceSeries(detail.trades), [detail.trades]);
  const { data: holderData } = useHolders(mint);
  const holders = holderData?.holders ?? null;
  const [tab, setTab] = useState<CoinTab>("trades");
  const stone = useTexture("stone", 6);
  // A link to /coin/<mint>#predictions (the home page's live row) opens the predictions tab.
  useEffect(() => {
    if (!predictions) return;
    const follow = () => {
      if (window.location.hash === "#predictions") setTab("predictions");
    };
    const first = setTimeout(follow, 0);
    window.addEventListener("hashchange", follow);
    return () => {
      clearTimeout(first);
      window.removeEventListener("hashchange", follow);
    };
  }, [predictions]);

  const { coin, trades, holdings } = detail;
  const tabs: CoinTab[] = predictions ? ["trades", "predictions", "holders"] : ["trades", "holders"];

  return (
    <div className="cp">
      <header className="cp-head">
        <div className="slot cp-thumb">
          <StreamThumb streamUrl={coin.streamUrl} seedKey={coin.mint} sizes="72px" />
        </div>
        <div className="cp-id">
          <div className="ticker-row">
            <h1>${coin.symbol}</h1>
            <span className="cp-by">
              {coin.name} · by {shortAddress(coin.creator)}
            </span>
            <UnverifiedTag tappable />
          </div>
          <p className="cp-cap num">
            market cap {formatSol(coin.marketCapSol)} SOL
            {change !== null && <span className={change >= 0 ? "up" : "down"}> · {signedPercent(change)}</span>}
          </p>
        </div>
      </header>
      <div className="cp-main">
        <div className="cp-stream">
          <StreamEmbed coin={coin} />
        </div>
        <section className="p cp-chart" aria-label="Price chart">
          {points.length > 0 ? <PriceChart points={points} /> : <p className="mute chart-empty">The chart starts with the first trade.</p>}
        </section>
        <div className="cp-tabs" id="predictions">
          <div className="sort" role="group" aria-label="Trades, predictions and holders">
            {tabs.map((key) => (
              <button
                type="button"
                key={key}
                aria-pressed={tab === key}
                className={`mbtn${tab === key ? "" : " off"}`}
                style={tab === key ? stone : undefined}
                onClick={() => setTab(key)}
              >
                {key}
              </button>
            ))}
          </div>
          {tab === "trades" && (
            <section className="p" aria-label="Recent trades">
              <TradeList trades={trades} symbol={coin.symbol} />
            </section>
          )}
          {/* Kept mounted while hidden, so its sign-in and open prediction survive a tab switch. */}
          {predictions && (
            <div hidden={tab !== "predictions"}>
              <Predictions mint={coin.mint} symbol={coin.symbol} streamUrl={coin.streamUrl} network={network} markets={markets} />
            </div>
          )}
          {tab === "holders" && (
            <section className="p" aria-label="Holders">
              <HolderList holders={holders} />
            </section>
          )}
        </div>
      </div>
      <aside className="cp-side">
        <div className="cp-trade">
          {coin.status === "graduating" ? (
            <div className="p">
              <p style={{ fontSize: 26 }}>The curve is full. Graduate the coin to open its Meteora pool.</p>
            </div>
          ) : (
            // key: a fresh trade box per coin, so typed state never carries over between coins.
            <TradeBox key={coin.mint} coin={coin} holdings={holdings} onTraded={refresh} />
          )}
          <CoinActions coin={coin} holdings={holdings} onDone={refresh} />
        </div>
        <div className="cp-curve">
          <CurveProgress coin={coin} />
        </div>
        <section className="p cp-holders" aria-label="Holder distribution">
          <h2>holder distribution</h2>
          <HolderList holders={holders} limit={10} />
        </section>
      </aside>
    </div>
  );
}
