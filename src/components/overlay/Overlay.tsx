"use client";
/**
 * The OBS overlay: a coin's ticker, market cap, change and XP graduation bar, drawn over the stream.
 * Read-only (no wallet, no transactions). Three layouts (a, b, c).
 * `preview` paints a stand-in stream behind it so it can be checked outside OBS.
 */
import { type CoinDetail, useCoin, usePriceTrend } from "@/components/hooks";
import { Scene, Sprite, XpBar } from "@/components/pixel/Pixel";
import { StreamThumb } from "@/components/pixel/StreamThumb";
import { useHostname } from "@/components/use-hostname";
import { parseStreamLink } from "@/lib/stream-link";
import { formatSol, signedPercent } from "@/lib/format";

export type OverlayLayout = "a" | "b" | "c";

type Props = { mint: string; initial: CoinDetail | null; layout: OverlayLayout; link: string; preview: boolean };

export function Overlay({ mint, initial, layout, link, preview }: Props) {
  // Polls every 5 s and keeps the last good value through errors (never flashes empty).
  const { data } = useCoin(mint, null, initial);
  const detail = data ?? initial;
  const { change } = usePriceTrend(detail);
  // OBS composites the page over the stream: the server HTML itself must not paint a background.
  const transparent = preview ? null : <style>{"html,body{background:transparent!important}"}</style>;
  if (!detail) {
    return (
      <div className="overlay-root">
        {transparent}
        {preview && <p className="notice">Coin not found yet; the overlay appears when it is.</p>}
      </div>
    );
  }
  const { coin } = detail;
  const graduated = coin.status === "graduated";

  const ticker = <span className="hf">${coin.symbol}</span>;
  const cap = <span className="hf num">{formatSol(coin.marketCapSol)} SOL</span>;
  const changeText = change === null ? null : <span className={`num ${change >= 0 ? "up" : "down"}`}>{signedPercent(change)}</span>;
  const bar = <XpBar progress={coin.progress} label={graduated ? "Graduated" : undefined} />;

  return (
    <div className="overlay-root">
      {transparent}
      {preview && <PreviewStream streamUrl={coin.streamUrl} seedKey={mint} />}

      {layout === "a" && (
        <div className="p ovA">
          <div className="oh">
            <div className="slot" style={{ overflow: "hidden" }}>
              <StreamThumb streamUrl={coin.streamUrl} seedKey={mint} sizes="76px" />
            </div>
            <div className="tk">{ticker}</div>
            <div className="r">
              <div className="mc">{cap}</div>
              <div className="ch">{changeText}</div>
            </div>
            {/* Its own full-width row, so a long host never cuts off the ticker. */}
            <div className="where">{link}</div>
          </div>
          {bar}
          <div className="gl">{graduated ? "Now trading on Meteora" : "to graduation"}</div>
        </div>
      )}

      {layout === "b" && (
        <div className="p ovB">
          <div className="slot">
            <Sprite name="coin" />
          </div>
          <div className="tk">{ticker}</div>
          <div className="mc">{cap}</div>
          <div className="ch">{changeText}</div>
          <div className="w">{bar}</div>
          <div className="where">{link}</div>
        </div>
      )}

      {layout === "c" && (
        <div className="ovC">
          <XpBar progress={coin.progress} label={graduated ? "Graduated" : undefined} big />
          <div className="hot">
            <div className="slot">
              <Sprite name="coin" />
              {ticker}
            </div>
            <div className="slot">{cap}</div>
            <div className="slot">{changeText ?? <span className="mute">-</span>}</div>
            <div className="slot">
              <span className="where">{link}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Preview only: the coin's real stream behind the overlay (YouTube/Twitch), else a pixel stand-in. */
function PreviewStream({ streamUrl, seedKey }: { streamUrl: string | null; seedKey: string }) {
  const host = useHostname();
  const link = streamUrl ? parseStreamLink(streamUrl) : null;
  return (
    <div className="overlay-preview-bg">
      {link && link.platform !== "kick" && host ? (
        <iframe
          src={link.embedUrl(host)}
          title="Stream preview"
          allow="autoplay"
          style={{ width: "100%", height: "100%", border: 0 }}
        />
      ) : (
        <Scene seedKey={`${seedKey}-stream`} width={240} height={135} />
      )}
    </div>
  );
}
