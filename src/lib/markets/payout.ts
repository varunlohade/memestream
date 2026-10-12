/**
 * What a market's shares pay, as the card shows it. A winning share pays 1 SOL; on a refund every
 * share pays 0.5 SOL (payout numerators [1, 1]). Pure, so the browser can import it.
 */
import { compact } from "@/lib/format";
import type { MarketPosition } from "./record";

/** If the bought side wins: SOL paid out (1 per share) and the profit on the SOL spent, as a fraction. */
export function winPayout(spentSol: number, shares: number): { sol: number; profit: number } {
  return { sol: shares, profit: spentSol > 0 ? (shares - spentSol) / spentSol : 0 };
}

/** "+91%" or "-4%". */
export const profitText = (profit: number) => `${profit >= 0 ? "+" : "-"}${Math.round(Math.abs(profit) * 100)}%`;

/**
 * The result line for the wallet once the market is resolved, and whether it has anything to redeem.
 * `numerators` is the question's [YES, NO] payout.
 */
export function resultLine(numerators: readonly number[] | null, position: MarketPosition | null): { text: string; redeem: boolean } {
  const [yes, no] = numerators ?? [0, 0];
  const total = yes + no || 1;
  const held = { yes: Number(position?.yes ?? 0), no: Number(position?.no ?? 0) };
  if (!(held.yes > 0) && !(held.no > 0)) return { text: "You held no shares", redeem: false };
  const sol = (held.yes * yes + held.no * no) / total;
  if (yes && no) return { text: `Refund: ${compact(sol)} SOL (0.5 per share)`, redeem: true };
  if (sol > 0) return { text: `You won ${compact(sol)} SOL`, redeem: true };
  const [winner, loser] = yes ? ["YES", "NO"] : ["NO", "YES"];
  return { text: `Your ${loser} shares pay 0. ${winner} won.`, redeem: false };
}
