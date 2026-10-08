"use client";
import { useMemo, useState } from "react";
import { type CoinDetail, type CoinView, type TradeView, useCoin } from "@/components/hooks";
import { useTx } from "@/components/tx";
import { useHostname } from "@/components/use-hostname";
import { Scene, Sprite, StepChart, XpBar } from "@/components/pixel/Pixel";
import { StreamThumb } from "@/components/pixel/StreamThumb";
import { useWallet } from "@/components/wallet/WalletProvider";
import { ago, compact, percentChange, shortAddress, signedPercent, sol } from "@/lib/format";
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
      <span className="live">{coin.status === "graduated" ? "Graduated" : "Live"}</span>
    </div>
  );
}

function TradeList({ trades, symbol }: { trades: TradeView[]; symbol: string }) {
  if (trades.length === 0) return <p className="mute" style={{ fontSize: 24 }}>No trades yet.</p>;
  return (
    <ul className="trade-list">
      {trades.map((t) => (
        <li className="tr num" key={t.signature}>
          <span className={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "Buy" : "Sell"}</span>
          <span>{sol(t.sol)} SOL</span>
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

/** Claim (for the streamer) and Graduate (for anyone, once the curve is full). */
function CoinActions({ coin, onDone }: { coin: CoinView; onDone: () => void }) {
  const { address } = useWallet();
  const { run: runTx, locked } = useTx();
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isStreamer = address === coin.creator;
  const canClaim = isStreamer && Number(coin.streamerUnclaimedSol) > 0;
  const canGraduate = coin.status === "graduating" && Boolean(address);
  if (!isStreamer && !canGraduate) return null;

  const run = async (action: "claim" | "graduate", done: string) => {
    if (!address) return;
    setStatus(null);
    try {
      await runTx(action, `${action === "claim" ? "Claim" : "Graduate"} ${coin.symbol}`, { wallet: address, mint: coin.mint }, setBusy);
      setStatus({ error: false, text: done });
      onDone();
    } catch (e) {
      setStatus({ error: true, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="p" aria-label="Coin actions" style={{ display: "grid", gap: 12 }}>
      {isStreamer && (
        <>
          <div className="lbl mute">Your earnings</div>
          <div className="cap num" style={{ fontSize: 34 }}>{sol(coin.streamerUnclaimedSol)} SOL</div>
          <button type="button" className="mbtn buy" disabled={!canClaim || Boolean(busy) || Boolean(locked)} onClick={() => run("claim", "Earnings sent to your wallet")}>
            {busy ?? "Claim earnings"}
          </button>
        </>
      )}
      {canGraduate && (
        <button type="button" className="mbtn buy" disabled={Boolean(busy) || Boolean(locked)} onClick={() => run("graduate", "Graduated to Meteora")}>
          {busy ?? "Graduate to Meteora"}
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
  const prices = useMemo(() => [...(detail?.trades ?? [])].reverse().map((t) => t.priceSol), [detail]);

  const { coin, trades, holdings } = detail;
  const change = prices.length > 1 ? percentChange(prices[0], coin.priceSol) : null;
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
              <h1>${coin.symbol}</h1>
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
          <div className="cap num">{sol(coin.marketCapSol)} SOL</div>
          {change !== null && (
            <div className={`chg num ${change >= 0 ? "up" : "down"}`}>{signedPercent(change)} over recent trades</div>
          )}
          <div className="chart">
            <StepChart values={prices} />
          </div>
          <div className="gradlbl">
            <span>Graduation</span>
            <span className="mute num">
              {sol(coin.raisedSol)} of {sol(coin.thresholdSol)} SOL
            </span>
          </div>
          <XpBar progress={coin.progress} label={graduated ? "Graduated" : undefined} />
          <div className="fees">
            <Sprite name="heart" />
            <span>80% of fees go to the streamer</span>
          </div>
        </section>
        {graduated ? (
          <div className="p">
            <p style={{ fontSize: 26 }}>This coin graduated. It now trades in a Meteora pool.</p>
          </div>
        ) : coin.status === "graduating" ? (
          <div className="p">
            <p style={{ fontSize: 26 }}>The curve is full. Graduate the coin to open its Meteora pool.</p>
          </div>
        ) : (
          // key: a fresh trade box per coin, so typed state never carries over between coins.
          <TradeBox key={coin.mint} coin={coin} holdings={holdings} onTraded={refresh} />
        )}
        <CoinActions coin={coin} onDone={refresh} />
      </div>
    </div>
  );
}
