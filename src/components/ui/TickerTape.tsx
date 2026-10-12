"use client";
/**
 * The ticker tape under the top bar (SPEC "Ticker tape", design B): live trades and graduations,
 * with graduation-race filler when it's quiet. Scrolls at ~40 px/s, pauses on hover or focus, and
 * stands still (scroll by hand) under reduced motion. Hidden when there are no coins.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { Sprite } from "@/components/pixel/Pixel";
import { usePolledTape } from "@/components/hooks";
import type { TapeItem } from "@/lib/api-types";
import { formatSol, shortAddress } from "@/lib/format";

const SCROLL_PX_PER_SECOND = 40;

function Item({ item }: { item: TapeItem }) {
  const href = `/coin/${item.mint}`;
  if (item.kind === "graduated") {
    return (
      <Link href={href} className="tape-item grad">
        <Sprite name="coin" className="tape-coin" />${item.symbol} graduated to Meteora
      </Link>
    );
  }
  if (item.kind === "race") {
    const percent = Math.floor(Math.min(Math.max(item.progress, 0), 1) * 100);
    return (
      <Link href={href} className="tape-item">
        ${item.symbol}
        <span className="tape-xp" aria-hidden>
          <b style={{ width: `${percent}%` }} />
        </span>
        <span className="tape-pct">{percent}%</span>
      </Link>
    );
  }
  const bought = item.side === "buy";
  return (
    <Link href={href} className="tape-item">
      <span className="tape-wallet">{shortAddress(item.wallet)}</span>
      <span className={bought ? "up" : "down"}>{bought ? "bought" : "sold"}</span>
      {formatSol(item.sol)} SOL of ${item.symbol}
    </Link>
  );
}

function Items({ items, copy }: { items: TapeItem[]; copy?: boolean }) {
  return (
    <ul className="tape-list" aria-hidden={copy || undefined}>
      {items.map((item, i) => (
        <li key={`${item.kind}-${item.mint}-${i}`} inert={copy || undefined}>
          <Item item={item} />
        </li>
      ))}
    </ul>
  );
}

/** The scrolling tape, everywhere but coin pages (there the predictions come first, near the top). */
export function TickerTape() {
  // The path is only known at request time, so it streams in (the tape is not part of the prerender).
  return (
    <Suspense fallback={null}>
      <TapeOffCoinPages />
    </Suspense>
  );
}

function TapeOffCoinPages() {
  const path = usePathname();
  if (path?.startsWith("/coin/")) return null;
  return <Tape />;
}

function Tape() {
  const { data } = usePolledTape();
  const items = data?.items ?? [];
  const first = useRef<HTMLDivElement>(null);
  const [seconds, setSeconds] = useState(60);

  // One full loop moves the track by one copy's width, at a steady speed whatever the content.
  useLayoutEffect(() => {
    const width = first.current?.scrollWidth ?? 0;
    if (width > 0) setSeconds(Math.max(10, width / SCROLL_PX_PER_SECOND));
  }, [data]);

  if (items.length === 0) return null;
  return (
    <nav className="tape" aria-label="Live trades">
      <div className="tape-track" style={{ animationDuration: `${seconds}s` }}>
        <div ref={first}>
          <Items items={items} />
        </div>
        <Items items={items} copy />
      </div>
    </nav>
  );
}
