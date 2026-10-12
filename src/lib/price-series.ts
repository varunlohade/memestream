import type { TradeView } from "./api-types";

/** One chart point: unix seconds and SOL per coin. */
export type PricePoint = { time: number; value: number };

/**
 * Trades (any order) -> chart points, oldest first. The chart needs strictly increasing times, so
 * trades in the same second merge into one point at the last trade's price. Trades with no time
 * or no usable price are left out.
 */
export function priceSeries(trades: TradeView[]): PricePoint[] {
  // The API lists trades newest first; reverse so a same-second tie keeps the later trade last.
  const usable = [...trades]
    .reverse()
    .filter((t): t is TradeView & { time: number } => t.time !== null && Number.isFinite(t.priceSol) && t.priceSol > 0)
    .sort((a, b) => a.time - b.time);
  const points: PricePoint[] = [];
  for (const trade of usable) {
    const last = points.at(-1);
    if (last?.time === trade.time) last.value = trade.priceSol;
    else points.push({ time: trade.time, value: trade.priceSol });
  }
  return points;
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/** SOL per coin for the chart axis: 0.0412, or 0.0₇281 (seven zeros after the point) for tiny prices. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1) return String(Number(value.toPrecision(4)));
  const [mantissa, exponent] = abs.toExponential(2).split("e");
  const zeros = -Number(exponent) - 1;
  const digits = mantissa.replace(".", "").replace(/0+$/, "");
  const sign = value < 0 ? "-" : "";
  if (zeros < 0) return `${sign}1`; // rounded up to 1 (e.g. 0.9999)
  if (zeros < 4) return `${sign}0.${"0".repeat(zeros)}${digits}`;
  const sub = String(zeros).replace(/\d/g, (d) => SUBSCRIPT[Number(d)]);
  return `${sign}0.0${sub}${digits}`;
}
