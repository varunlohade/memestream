/** Trade box maths: the input unit (SOL or the coin), its conversion at the coin's price, and the amount chips. */
import { COIN_DECIMALS, SOL_DECIMALS } from "./api-types";
import { fractionOf, minusReserve } from "./format";

export type Side = "buy" | "sell";
/** What the amount box is typed in. A buy always sends SOL and a sell always sends coins; the other unit converts. */
export type Unit = "sol" | "coin";

/** Each side's natural unit: buys are typed in SOL, sells in coins. */
export const NATURAL_UNIT: Record<Side, Unit> = { buy: "sol", sell: "coin" };

/** SOL kept back on "max" buys for network fees and the new token account's rent. */
export const SOL_RESERVE = "0.01";

/** Fixed coin amounts for a buy typed in coins. */
export const COIN_BUY_CHIPS = ["1000000", "10000000", "50000000"] as const;

/** `value` as a plain decimal string with at most `decimals` places, rounded down or up; "" if not a positive number. */
function toDecimal(value: number, decimals: number, round: "down" | "up"): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const scale = 10 ** decimals;
  const scaled = Number((value * scale).toPrecision(15)); // drops float noise like 30000000.000000004
  const units = round === "down" ? Math.floor(scaled) : Math.ceil(scaled);
  if (units <= 0) return "";
  return (units / scale).toFixed(decimals).replace(/\.?0+$/, "");
}

/** Coins -> SOL at `priceSol` (SOL per coin). An estimate: the curve's price moves as the trade fills. */
export function coinsToSol(coins: string, priceSol: number, round: "down" | "up" = "down"): string {
  return toDecimal(Number(coins) * priceSol, SOL_DECIMALS, round);
}

/** SOL -> coins at `priceSol` (SOL per coin). An estimate, like coinsToSol. */
export function solToCoins(sol: string, priceSol: number, round: "down" | "up" = "down"): string {
  return priceSol > 0 ? toDecimal(Number(sol) / priceSol, COIN_DECIMALS, round) : "";
}

/** The smaller of two decimal coin strings. */
function minCoins(a: string, b: string): string {
  return Number(a) <= Number(b) ? a : b;
}

/**
 * What the trade request sends: SOL for a buy, coins for a sell ("" = nothing to trade).
 * A sell typed in SOL rounds its coins up so "100%" sells everything, then caps at what the wallet holds.
 */
export function tradeAmount(side: Side, unit: Unit, typed: string, priceSol: number, heldCoins: string | null): string {
  if (unit === NATURAL_UNIT[side]) return typed;
  if (side === "buy") return coinsToSol(typed, priceSol);
  const coins = solToCoins(typed, priceSol, "up");
  return coins && heldCoins !== null ? minCoins(coins, heldCoins) : coins;
}

/** The typed amount re-expressed in the other unit, when the user flips the unit switch. */
export function convertTyped(typed: string, from: Unit, priceSol: number): string {
  if (!typed.trim()) return "";
  return from === "sol" ? solToCoins(typed, priceSol) : coinsToSol(typed, priceSol);
}

/** A chip sets the amount box. "" clears it (reset); null = unavailable (no wallet, nothing held). */
export type Chip = { label: string; amount: string | null };

/** "1000000" -> "1M" for chip labels. */
const coinLabel = (coins: string) => `${Number(coins) / 1e6}M`;

/** Buy in SOL: reset, 0.1, 0.5, 1, max. Buy in coins: reset plus fixed amounts. Sell: reset plus shares of what's held. */
export function tradeChips(side: Side, unit: Unit, holdings: { sol: string; coins: string } | null, priceSol: number): Chip[] {
  const reset: Chip = { label: "reset", amount: "" };
  if (side === "buy") {
    if (unit === "coin") return [reset, ...COIN_BUY_CHIPS.map((coins) => ({ label: coinLabel(coins), amount: coins }))];
    return [
      reset,
      ...["0.1", "0.5", "1"].map((sol) => ({ label: sol, amount: sol })),
      { label: "max", amount: holdings ? minusReserve(holdings.sol, SOL_RESERVE, SOL_DECIMALS) : null },
    ];
  }
  const share = (percent: number): string | null => {
    if (!holdings) return null;
    const coins = fractionOf(holdings.coins, percent, COIN_DECIMALS);
    return unit === "coin" ? coins : coinsToSol(coins, priceSol, "up") || "0";
  };
  return [reset, ...[25, 50, 75, 100].map((percent) => ({ label: `${percent}%`, amount: share(percent) }))];
}

/** "set max slippage" choices, in basis points, with their labels. */
export const slippageLabel = (bps: number) => `${bps / 100}%`;
