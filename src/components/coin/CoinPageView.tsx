"use client";
import { useState } from "react";
import { type CoinDetail, type CoinView, type Holdings, type TradeView, useCoin, usePriceTrend } from "@/components/hooks";
import { useTx } from "@/components/tx";
import { useHostname } from "@/components/use-hostname";
import { Scene, Sprite, StepChart, XpBar } from "@/components/pixel/Pixel";
import { StreamThumb } from "@/components/pixel/StreamThumb";
import { LiveBadge } from "@/components/ui/LiveBadge";
import { UnverifiedTag } from "@/components/UnverifiedTag";
import { useWallet } from "@/components/wallet/WalletProvider";
import { ago, compact, formatSol, shortAddress, SIDE_LABEL, signedPercent } from "@/lib/format";
import { parseStreamLink } from "@/lib/stream-link";
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
  const cluster = chain === "solana:mainnet" ? "" : `?cluster=${chain.replace("solana:", "")}`;
  return (
    <p className="mute meteora-note">
      Graduated: trades in its Meteora pool.{" "}
      <a href={`https://explorer.solana.com/address/${coin.meteoraPool}${cluster}`} target="_blank" rel="noopener noreferrer">
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
          <span className="r mute">{ago(t.time)} ago</span>
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
  /** The running action's stage ("Check your wallet"...), shown on its button; null when idle. */
  const [stage, setStage] = useState<string | null>(null);
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
      await runTx(action, `${ACTION_LABEL[action]} ${coin.symbol}`, { wallet: address, mint: coin.mint }, setStage);
      setStatus({ error: false, text: successText });
      onDone();
    } catch (e) {
      setStatus({ error: true, text: (e as Error).message });
    } finally {
      setStage(null);
    }
  };

  return (
    <section className="p" aria-label="Coin actions" style={{ display: "grid", gap: 12 }}>
      {isStreamer && (
        <>
          <div className="lbl mute">Your earnings</div>
          <div className="cap num" style={{ fontSize: 34 }}>{formatSol(coin.streamerUnclaimedSol)} SOL</div>
          <button type="button" className="mbtn buy" disabled={!canClaim || Boolean(stage) || Boolean(locked)} onClick={() => runAction("claim", "Earnings sent to your wallet")}>
            {stage ?? "Claim earnings"}
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
            {stage ?? "Claim pool fees"}
          </button>
        </>
      )}
      {canGraduate && (
        <button type="button" className="mbtn buy" disabled={Boolean(stage) || Boolean(locked)} onClick={() => runAction("graduate", "Graduated to Meteora")}>
          {stage ?? "Graduate to Meteora"}
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

/** `initial` is rendered by the server; polling keeps it fresh and adds the wallet's holdings. */
export function CoinPageView({ mint, initial }: { mint: string; initial: CoinDetail }) {
  const { address } = useWallet();
  const { data, refresh } = useCoin(mint, address, initial);
  const detail = data ?? initial;
  const { prices, change } = usePriceTrend(detail);

  const { coin, trades, holdings } = detail;
  const graduated = coin.status === "graduated";

  return (
    <div className="coin">
      <div>
        <StreamEmbed coin={coin} />
        <div className="p" style={{ marginTop: 24 }}>
          <div className="ident">
            <div className="slot" style={{ overflow: "hidden" }}>
              <StreamThumb streamUrl={coin.streamUrl} seedKey={coin.mint} sizes="84px" />
            </div>
            <div>
              <div className="ticker-row">
                <h1>${coin.symbol}</h1>
                <UnverifiedTag tappable />
              </div>
              <p>
                {coin.name} by {shortAddress(coin.creator)}
              </p>
            </div>
          </div>
          <div className="trades">
            <h2>Recent trades</h2>
            <TradeList trades={trades} symbol={coin.symbol} />
          </div>
        </div>
      </div>
      <div className="side">
        <section className="p" aria-label="Price and graduation">
          <div className="lbl mute">Market cap</div>
          <div className="cap num">{formatSol(coin.marketCapSol)} SOL</div>
          {change !== null && (
            <div className={`chg num ${change >= 0 ? "up" : "down"}`}>{signedPercent(change)} over recent trades</div>
          )}
          <div className="chart">
            <StepChart values={prices} />
          </div>
          <div className="gradlbl">
            <span>Graduation</span>
            <span className="mute num">
              {formatSol(coin.raisedSol)} of {formatSol(coin.thresholdSol)} SOL
            </span>
          </div>
          <XpBar progress={coin.progress} label={graduated ? "Graduated" : undefined} />
          <div className="fees">
            <Sprite name="heart" />
            <span>80% of fees go to the streamer</span>
          </div>
        </section>
        {graduated ? (
          <>
            <TradeBox key={coin.mint} coin={coin} holdings={holdings} onTraded={refresh} />
            <MeteoraNote coin={coin} />
          </>
        ) : coin.status === "graduating" ? (
          <div className="p">
            <p style={{ fontSize: 26 }}>The curve is full. Graduate the coin to open its Meteora pool.</p>
          </div>
        ) : (
          // key: a fresh trade box per coin, so typed state never carries over between coins.
          <TradeBox key={coin.mint} coin={coin} holdings={holdings} onTraded={refresh} />
        )}
        <CoinActions coin={coin} holdings={holdings} onDone={refresh} />
      </div>
    </div>
  );
}
