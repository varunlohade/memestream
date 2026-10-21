"use client";
/** Client-side data hooks. They call our own API routes; the browser never talks to RPC directly. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CoinDetail, CoinView, HolderView, TapeItem, TradePreview } from "@/lib/api-types";
import type { LiveFeed } from "@/lib/predictions/live";
import { percentChange } from "@/lib/format";
import { fetchJson } from "@/lib/http";
import { QUOTE_REFRESH_MS, quoteUrl } from "@/lib/trade-box";

export type { CoinDetail, CoinView, HolderView, Holdings, TradePreview, TradeView } from "@/lib/api-types";

const POLL_MS = 5_000;
/** A hung request can't freeze polling: each one gives up after this and the next is scheduled. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Polls `url`: one request at a time (the next starts after the last ends), paused while the
 * tab is hidden, and reset when the URL changes so stale data (e.g. another wallet's) never shows.
 */
function usePolled<T>(url: string, initial: T | null = null, pollMs = POLL_MS) {
  const [state, setState] = useState<{ url: string; data: T | null; error: string | null }>({
    url,
    data: initial,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.hidden) {
        timer = setTimeout(load, pollMs);
        return;
      }
      try {
        const data = await fetchJson<T>(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
        setState({ url, data, error: null });
      } catch (e) {
        if (controller.signal.aborted) return;
        setState((s) => ({ url, data: s.url === url ? s.data : null, error: (e as Error).message }));
      }
      if (!controller.signal.aborted) timer = setTimeout(load, pollMs);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, tick, pollMs]);

  const current = state.url === url;
  return { data: current ? state.data : null, error: current ? state.error : null, refresh };
}

export const useCoins = () => usePolled<{ coins: CoinView[] }>("/api/coins");

/** The site's ticker tape: recent trades and graduations (see lib/tape.ts). */
export const usePolledTape = () => usePolled<{ items: TapeItem[] }>("/api/tape");

/** Predictions open for bets across coins (home page row). The server caches them for 5 s. */
export const useLivePredictions = () => usePolled<LiveFeed>("/api/predictions/live", null, 10_000);

/** One coin, its recent trades, and (if a wallet is connected) that wallet's holdings. */
export const useCoin = (mint: string, wallet: string | null, initial: CoinDetail | null = null) =>
  usePolled<CoinDetail>(
    `/api/coins/${encodeURIComponent(mint)}${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ""}`,
    wallet ? null : initial,
  );

/** A coin's largest holders. The server caches them for 30 s, so a slower poll is enough. */
export const useHolders = (mint: string) => usePolled<{ holders: HolderView[] }>(`/api/coins/${encodeURIComponent(mint)}/holders`, null, 15_000);

/** Recent trade prices, oldest first (for the chart), and the % change from the oldest to now. */
export function usePriceTrend(detail: CoinDetail | null) {
  const prices = useMemo(() => [...(detail?.trades ?? [])].reverse().map((t) => t.priceSol), [detail]);
  const change = detail && prices.length > 1 ? percentChange(prices[0], detail.coin.priceSol) : null;
  return { prices, change };
}

const QUOTE_DEBOUNCE_MS = 300;

/**
 * Live price check for the trade box. `curveState` is anything that changes when the pool does (the
 * coin's raised SOL): after any trade lands, the old quote no longer counts and a fresh one is
 * fetched. A graduated coin's raised SOL never changes, so the quote is also fetched again every
 * QUOTE_REFRESH_MS while the tab is visible, and on `refresh()`; the last good quote stays on screen
 * while a refresh loads. `show(preview)` puts a quote fetched elsewhere for these same inputs on screen.
 */
export function useQuote(mint: string, side: "buy" | "sell", amount: string, curveState: string, slippageBps: number) {
  const [quote, setQuote] = useState<{ key: string; preview: TradePreview | null; error: string | null } | null>(null);
  const [round, setRound] = useState(0);
  const refresh = useCallback(() => setRound((r) => r + 1), []);
  const key = `${mint}|${side}|${amount}|${curveState}|${slippageBps}`;

  useEffect(() => {
    if (!amount.trim()) return;
    const ticker = setInterval(() => document.hidden || refresh(), QUOTE_REFRESH_MS);
    return () => clearInterval(ticker);
  }, [amount, refresh]);

  useEffect(() => {
    if (!amount.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const preview = await fetchJson<TradePreview>(quoteUrl(mint, side, amount, slippageBps), { signal: controller.signal });
        setQuote({ key, preview, error: null });
      } catch (e) {
        if (!controller.signal.aborted) setQuote({ key, preview: null, error: (e as Error).message });
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, round, mint, side, amount, slippageBps]);

  const show = useCallback((preview: TradePreview) => setQuote({ key, preview, error: null }), [key]);

  const fresh = quote?.key === key;
  return {
    preview: amount.trim() && fresh ? quote.preview : null,
    error: amount.trim() && fresh ? quote.error : null,
    loading: Boolean(amount.trim()) && !fresh,
    refresh,
    show,
  };
}
