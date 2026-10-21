"use client";
/** The coin page's price chart (TradingView lightweight-charts), drawn from the trades we already load. */
import { AreaSeries, ColorType, createChart, CrosshairMode, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { formatPrice, type PricePoint, samePoints } from "@/lib/price-series";

const LINE = "#7DFF8F";
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const timeLabel = (time: number) =>
  new Date(time * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
// The chart's own axis labels are UTC; these show the viewer's local time, like the tooltip.
const tickLabel = (time: number) => new Date(time * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const legendText = (point: PricePoint | undefined) => (point ? `${formatPrice(point.value)} SOL · ${timeLabel(point.time)}` : "");

/**
 * `coinKey` (the coin's mint): the chart fits all its trades on first load and when the coin changes;
 * later polls add trades but keep the range the user zoomed or scrolled to.
 */
export function PriceChart({ points, coinKey }: { points: PricePoint[]; coinKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const chart = useRef<{ api: IChartApi; series: ISeriesApi<"Area">; points: PricePoint[]; fittedFor: string | null } | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const api = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#9a9aa2", fontFamily: FONT, fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.05)" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.2, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: number) => tickLabel(time) },
      crosshair: { mode: CrosshairMode.Magnet },
      localization: { priceFormatter: formatPrice, timeFormatter: (time: number) => timeLabel(time) },
    });
    const series = api.addSeries(AreaSeries, {
      lineColor: LINE,
      lineWidth: 2,
      topColor: "rgba(125,255,143,0.28)",
      bottomColor: "rgba(125,255,143,0.02)",
      priceFormat: { type: "custom", formatter: formatPrice, minMove: 1e-12 },
      priceLineVisible: false,
    });
    const state = { api, series, points: [] as PricePoint[], fittedFor: null as string | null };
    chart.current = state;
    api.subscribeCrosshairMove((param) => {
      const hovered = param.time === undefined ? undefined : state.points.find((p) => p.time === param.time);
      if (legend.current) legend.current.textContent = legendText(hovered ?? state.points.at(-1));
    });
    return () => {
      chart.current = null;
      api.remove();
    };
  }, []);

  useEffect(() => {
    const current = chart.current;
    if (!current) return;
    const fit = current.fittedFor !== coinKey || current.points.length === 0;
    if (!fit && samePoints(current.points, points)) return;
    const timeScale = current.api.timeScale();
    const kept = fit ? null : timeScale.getVisibleLogicalRange();
    current.points = points;
    current.series.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    current.series.applyOptions({ pointMarkersVisible: points.length === 1 });
    if (fit) {
      timeScale.fitContent();
      current.fittedFor = coinKey;
    } else if (kept) timeScale.setVisibleLogicalRange(kept);
    if (legend.current) legend.current.textContent = legendText(points.at(-1));
  }, [points, coinKey]);

  return (
    <div className="price-chart">
      <div ref={box} className="price-chart-box" />
      <div ref={legend} className="price-chart-legend" />
    </div>
  );
}
