/**
 * Token units. Amounts on-chain are integers (BN) in base units; humans type decimals.
 * Parse and format through strings, never floats, so 0.1 SOL is exactly 100_000_000 lamports.
 */
import { TokenDecimal } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { SOL_DECIMALS } from "../api-types";
import { InputError } from "./errors";

/** Coins are priced in SOL. Mint and decimals change together. */
export const QUOTE = { mint: NATIVE_MINT, decimals: SOL_DECIMALS } as const;

/** Every stream coin uses 6 decimals. */
export const BASE_DECIMALS = TokenDecimal.SIX;

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** "1.25" with 9 decimals -> 1_250_000_000. Throws on bad input or too many decimal places. */
export function parseUnits(amount: string, decimals: number): BN {
  const text = amount.trim();
  if (!DECIMAL_PATTERN.test(text)) throw new InputError(`Not a positive decimal number: "${amount}"`);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new InputError(`At most ${decimals} decimal places`);
  return new BN(whole + fraction.padEnd(decimals, "0"));
}

/** 1_250_000_000 with 9 decimals -> "1.25". Trailing zeros dropped. */
export function formatUnits(amount: BN, decimals: number): string {
  const negative = amount.isNeg();
  const digits = amount.abs().toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const solToLamports = (sol: string) => parseUnits(sol, QUOTE.decimals);
export const lamportsToSol = (lamports: BN) => formatUnits(lamports, QUOTE.decimals);
export const coinsToBaseUnits = (coins: string) => parseUnits(coins, BASE_DECIMALS);
export const baseUnitsToCoins = (units: BN) => formatUnits(units, BASE_DECIMALS);

/** spl-token returns bigint amounts; the DBC SDK wants BN. */
export const toBN = (amount: bigint) => new BN(amount.toString());
