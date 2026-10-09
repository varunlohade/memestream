/**
 * The anti-sniper launch fee: 50% at launch, falling linearly to a 1% base over the first minute
 * (one step per second). Shared by the on-chain config (lib/dbc/preset.ts) and the trade box,
 * which shows the current fee and a countdown. Kept free of the Meteora SDK so the browser can
 * import it cheaply.
 */
export const LAUNCH_FEE = {
  startingFeeBps: 5_000,
  endingFeeBps: 100,
  numberOfPeriod: 60,
  totalDuration: 60,
} as const;

/**
 * The scheduled base fee (bps) and seconds until it reaches the 1% base, `elapsedSeconds` after a
 * coin's trading opened. Matches DBC's linear fee scheduler: one step per period. (A small
 * volatility fee can add on top during wild swings; the quote includes everything.)
 */
export function launchFeeAt(elapsedSeconds: number): { bps: number; secondsLeft: number } {
  const { startingFeeBps, endingFeeBps, numberOfPeriod, totalDuration } = LAUNCH_FEE;
  const elapsed = Math.max(0, elapsedSeconds);
  if (elapsed >= totalDuration) return { bps: endingFeeBps, secondsLeft: 0 };
  const period = Math.min(numberOfPeriod, Math.floor(elapsed / (totalDuration / numberOfPeriod)));
  const bps = startingFeeBps - ((startingFeeBps - endingFeeBps) * period) / numberOfPeriod;
  return { bps, secondsLeft: Math.ceil(totalDuration - elapsed) };
}
