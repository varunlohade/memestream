/** Display formatting shared by the UI. Inputs are plain numbers or decimal strings. */

/** 42100 -> "42.1K", 3.2 -> "3.2", 0.000012 -> "0.000012". */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  if (abs >= 1) return value.toFixed(abs >= 100 ? 0 : 2).replace(/\.?0+$/, "");
  if (abs === 0) return "0";
  if (abs < 0.000001) return "<0.000001";
  return String(Number(value.toPrecision(3)));
}

/** "12.3456789" -> "12.35" for SOL amounts in lists. */
export const formatSol = (amount: string | number) => compact(Number(amount));

export function percentChange(from: number, to: number): number | null {
  return from > 0 ? ((to - from) / from) * 100 : null;
}

export const signedPercent = (pct: number) => `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

/** Unix seconds -> "4s", "3m", "2h", "5d". */
export function ago(unixSeconds: number | null, now = Date.now()): string {
  if (unixSeconds === null) return "-";
  const seconds = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  if (seconds < SECONDS_PER_DAY) return `${Math.floor(seconds / SECONDS_PER_HOUR)}h`;
  return `${Math.floor(seconds / SECONDS_PER_DAY)}d`;
}

/* Exact decimal-string math for amount chips. Browser-safe (BigInt, no deps). */

function toUnits(value: string, decimals: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt((whole || "0") + fraction.padEnd(decimals, "0").slice(0, decimals));
}

function fromUnits(units: bigint, decimals: number): string {
  const digits = units.toString().padStart(decimals + 1, "0");
  const head = digits.slice(0, digits.length - decimals);
  const tail = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return tail ? `${head}.${tail}` : head;
}

/** `percent`% of a decimal string, rounded down: fractionOf("10.5", 50, 6) -> "5.25". */
export function fractionOf(amount: string, percent: number, decimals: number): string {
  return fromUnits((toUnits(amount, decimals) * BigInt(Math.round(percent * 100))) / BigInt(10_000), decimals);
}

/** `amount` minus `reserve`, floored at "0": keeps SOL back for fees and rent on "Max". */
export function minusReserve(amount: string, reserve: string, decimals: number): string {
  const left = toUnits(amount, decimals) - toUnits(reserve, decimals);
  return left > BigInt(0) ? fromUnits(left, decimals) : "0";
}

/** First 6 characters of a wallet or mint address, for compact display. */
export const shortAddress = (address: string) => address.slice(0, 6);
