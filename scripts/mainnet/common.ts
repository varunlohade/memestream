/**
 * Shared by the mainnet scripts (mainnet-config.mts, claim-partner-fees.mts). Nothing here signs
 * or sends: it builds, adds the priority fee, simulates and describes. Sending lives in the
 * scripts, behind --send and a typed confirmation.
 */
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { type Connection, Keypair, PublicKey, type Transaction, VersionedTransaction } from "@solana/web3.js";
import { isBase58Of } from "../../src/lib/base58";
import { addPriorityFee, maxPriorityFeeLamports, type PriorityFee, priorityFeeSettings } from "../../src/lib/priority-fee";
import { readKeypair } from "../keys";

export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

/** The RPC from MAINNET_RPC_URL, else Solana's public one (fine for one dry run; rate-limited). */
export const mainnetRpcUrl = () => process.env.MAINNET_RPC_URL || PUBLIC_MAINNET_RPC;

/** The RPC's host only: a paid RPC URL carries its API key, which must never be printed. */
export const rpcHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "(unparsable RPC URL)";
  }
};

export async function clusterName(connection: Connection): Promise<"mainnet" | "other"> {
  return (await connection.getGenesisHash()) === MAINNET_GENESIS_HASH ? "mainnet" : "other";
}

/** `--name value` from argv. */
export const argValue = (argv: string[], name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

export type Signer = { publicKey: PublicKey; keypair: Keypair | null };

/**
 * A key file (can sign) or a bare address (dry run only). The secret key is read into memory and
 * never printed.
 */
export function signerFrom(value: string | undefined, label: string): Signer {
  if (!value) throw new Error(`Give ${label}: a key file path, or an address for a dry run`);
  if (existsSync(value)) {
    const keypair = readKeypair(value);
    return { publicKey: keypair.publicKey, keypair };
  }
  if (isBase58Of(value, 32)) return { publicKey: new PublicKey(value), keypair: null };
  throw new Error(`${label}: no such key file, and not an address`);
}

export type Simulation = { ok: boolean; error: string | null; unitsConsumed: number | null; logs: string[]; payerCostLamports: number | null };

/**
 * Adds a fresh blockhash and the priority fee, then simulates (signatures not checked, so the
 * payer's key isn't needed). The payer must exist on chain with enough SOL for it to pass.
 */
export async function prepareAndSimulate(connection: Connection, tx: Transaction): Promise<{ priority: PriorityFee; simulation: Simulation; blockhash: string }> {
  const payer = tx.feePayer;
  if (!payer) throw new Error("No fee payer");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const priority = await addPriorityFee(connection, tx, priorityFeeSettings(process.env.MEMESTREAM_PRIORITY_FEE_MAX));
  const before = await connection.getBalance(payer, "confirmed");
  const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [payer.toBase58()] },
  });
  const after = sim.value.accounts?.[0]?.lamports;
  return {
    blockhash,
    priority,
    simulation: {
      ok: !sim.value.err,
      error: sim.value.err ? JSON.stringify(sim.value.err) : null,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      logs: sim.value.logs ?? [],
      payerCostLamports: after === undefined ? null : before - after,
    },
  };
}

export const priorityLine = (p: PriorityFee) =>
  `${p.microLamports.toLocaleString("en-US")} micro-lamports/CU, limit ${p.units.toLocaleString("en-US")} CU (${p.simulated ? "from simulation" : "fallback"}), at most ${maxPriorityFeeLamports(p).toLocaleString("en-US")} lamports`;

/** Asks the human to type `phrase` exactly; anything else stops. */
export async function typedConfirmation(question: string, phrase: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question}\nType exactly: ${phrase}\n> `)).trim() === phrase;
  } finally {
    rl.close();
  }
}
