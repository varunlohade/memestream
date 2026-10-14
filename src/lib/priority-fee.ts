/**
 * Priority fees, so a busy mainnet doesn't drop our transactions. Every transaction the server
 * builds gets two Compute Budget instructions up front:
 * - a compute unit limit: what a simulation used, plus a margin (or a fixed fallback if the
 *   simulation fails, e.g. the wallet can't afford it; the wallet then shows the real error);
 * - a compute unit price: a percentile of recent priority fees paid on the accounts it writes,
 *   kept between a floor and a cap. The cap bounds what any one transaction can cost the user.
 * Any Compute Budget instruction the SDK already added is replaced, so there's only ever one of each.
 * Takes a Connection, never a key; the scripts use it too.
 */
import { ComputeBudgetProgram, type Connection, type PublicKey, type Transaction, VersionedTransaction } from "@solana/web3.js";

export type PriorityFeeSettings = {
  /** Which percentile of recent fees to pay (0-100). */
  percentile: number;
  /** Floor and cap, in micro-lamports per compute unit. */
  minMicroLamports: number;
  maxMicroLamports: number;
  /** Compute unit limit when the simulation fails. */
  fallbackUnits: number;
};

/** The runtime's hard limit per transaction. */
export const MAX_COMPUTE_UNITS = 1_400_000;
/** The RPC looks at most this many accounts for recent fees. */
const MAX_FEE_ACCOUNTS = 128;
/** Simulated units are a little lower than a real run (state moves): add 20% and a flat 10k. */
const UNIT_MARGIN = 1.2;
const UNIT_PAD = 10_000;

/**
 * At the 1,000,000 cap, a 400k-unit transaction pays at most 0.0004 SOL in priority fee.
 * The floor (~0.000004 SOL at 400k units) keeps us out of the "no priority" queue on mainnet.
 */
export const DEFAULT_PRIORITY_FEE: PriorityFeeSettings = {
  percentile: 75,
  minMicroLamports: 10_000,
  maxMicroLamports: 1_000_000,
  fallbackUnits: 400_000,
};

/** The settings with the cap from env (micro-lamports per CU); a bad value keeps the default. */
export function priorityFeeSettings(maxFromEnv: string | undefined): PriorityFeeSettings {
  const max = Number(maxFromEnv);
  if (!maxFromEnv || !Number.isSafeInteger(max) || max <= 0) return DEFAULT_PRIORITY_FEE;
  return { ...DEFAULT_PRIORITY_FEE, maxMicroLamports: max, minMicroLamports: Math.min(DEFAULT_PRIORITY_FEE.minMicroLamports, max) };
}

/** The given percentile of recent per-slot fees, clamped to [floor, cap]. No samples: the floor. */
export function pickMicroLamports(samples: number[], settings: PriorityFeeSettings): number {
  const sorted = samples.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const at = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((settings.percentile / 100) * sorted.length) - 1)] : 0;
  return Math.round(Math.min(settings.maxMicroLamports, Math.max(settings.minMicroLamports, at ?? 0)));
}

/** The limit for a simulated run (with margin), or the fallback; never above the runtime's limit. */
export function computeUnitLimit(consumed: number | undefined, settings: PriorityFeeSettings): number {
  const units = consumed && consumed > 0 ? Math.ceil(consumed * UNIT_MARGIN) + UNIT_PAD : settings.fallbackUnits;
  return Math.min(MAX_COMPUTE_UNITS, units);
}

/** Puts exactly one unit limit and one unit price first, replacing any the builder added. */
export function setComputeBudget(tx: Transaction, units: number, microLamports: number): void {
  const rest = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  tx.instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...rest,
  ];
}

/** The accounts the transaction writes to: the ones whose fee market it competes in. */
export function writableAccounts(tx: Transaction): PublicKey[] {
  const message = tx.compileMessage();
  return message.accountKeys.filter((_, i) => message.isAccountWritable(i)).slice(0, MAX_FEE_ACCOUNTS);
}

export type PriorityFee = { units: number; microLamports: number; simulated: boolean };

/**
 * Adds the priority fee to an unsigned transaction (fee payer and blockhash already set). Sign
 * after this: it changes the message. RPC calls: recent fees and one simulation (sigVerify off).
 */
export async function addPriorityFee(connection: Connection, tx: Transaction, settings: PriorityFeeSettings = DEFAULT_PRIORITY_FEE): Promise<PriorityFee> {
  if (!tx.feePayer || !tx.recentBlockhash) throw new Error("Set the fee payer and blockhash before the priority fee");
  const recent = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writableAccounts(tx) }).catch(() => []);
  const microLamports = pickMicroLamports(
    recent.map((r) => r.prioritizationFee),
    settings,
  );
  // Simulate at the full limit with the real price, so the fee-payer balance check is the real one.
  setComputeBudget(tx, MAX_COMPUTE_UNITS, microLamports);
  const consumed = await connection
    .simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" })
    .then((sim) => (sim.value.err ? undefined : sim.value.unitsConsumed))
    .catch(() => undefined);
  const units = computeUnitLimit(consumed, settings);
  setComputeBudget(tx, units, microLamports);
  return { units, microLamports, simulated: consumed !== undefined };
}

/** The most a transaction with this budget pays in priority fee, in lamports (rounded up). */
export const maxPriorityFeeLamports = ({ units, microLamports }: Pick<PriorityFee, "units" | "microLamports">) =>
  Math.ceil((units * microLamports) / 1_000_000);
