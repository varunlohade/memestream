/** Server-side Solana access and settings. The only place the app reads RPC configuration. */
import "server-only";
import { createHash } from "node:crypto";
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, PublicKey, type Transaction } from "@solana/web3.js";
import { QUOTE } from "@/lib/dbc/units";

export type Chain = {
  client: DynamicBondingCurveClient;
  connection: Connection;
  /** The shared memestream DBC config every coin launches on. */
  config: PublicKey;
  /** Public base URL baked into each coin's on-chain metadata URI. Never taken from request headers. */
  publicUrl: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

let cached: (Chain & { envKey: string }) | undefined;

/** Built once, and again whenever the RPC/config env changes (each dev-chain restart). */
export function getChain(): Chain {
  const envKey = `${process.env.MEMESTREAM_RPC_URL}|${process.env.MEMESTREAM_CONFIG}|${process.env.MEMESTREAM_PUBLIC_URL}`;
  if (cached?.envKey === envKey) return cached;
  const connection = new Connection(requireEnv("MEMESTREAM_RPC_URL"), "confirmed");
  cached = {
    connection,
    client: new DynamicBondingCurveClient(connection, "confirmed"),
    config: new PublicKey(requireEnv("MEMESTREAM_CONFIG")),
    publicUrl: requireEnv("MEMESTREAM_PUBLIC_URL").replace(/\/$/, ""),
    envKey,
  };
  return cached;
}

/** What the UI shows and which Wallet Standard chain it asks wallets for. */
export function networkInfo() {
  return {
    label: process.env.MEMESTREAM_NETWORK_LABEL ?? "Devnet",
    walletChain: (process.env.MEMESTREAM_WALLET_CHAIN ?? "solana:devnet") as `${string}:${string}`,
  };
}

/** A coin's pool address, computed from its mint and our config: no account scan needed. */
export function poolForMint(mint: string): PublicKey | null {
  try {
    return deriveDbcPoolAddress(QUOTE.mint, new PublicKey(mint), getChain().config);
  } catch {
    return null;
  }
}

export { signatureStatus } from "@/lib/tx-status";

/**
 * Message hashes of transactions this server built recently. The localhost test wallet signs
 * only these, so it can never be tricked into signing someone else's transaction.
 */
const BUILT_TTL_MS = 5 * 60_000;
const builtHere = new Map<string, number>();
const messageHash = (tx: Transaction) => createHash("sha256").update(tx.serializeMessage()).digest("hex");

export function rememberBuilt(tx: Transaction) {
  const now = Date.now();
  for (const [hash, at] of builtHere) if (now - at > BUILT_TTL_MS) builtHere.delete(hash);
  builtHere.set(messageHash(tx), now);
}

export const wasBuiltHere = (tx: Transaction) => builtHere.has(messageHash(tx));
