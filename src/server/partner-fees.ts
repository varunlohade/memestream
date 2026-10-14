/**
 * memestream's own fees on the shared config (lib/dbc/partner-fees.ts), for the admin page
 * (/admin/fees). Only an admin (MEMESTREAM_ADMIN_WALLETS) signed in as the config's fee claimer
 * gets claim transactions; they come back unsigned, for that wallet to sign. The server holds no key.
 */
import "server-only";
import { PublicKey } from "@solana/web3.js";
import type { PreparedTx } from "@/lib/api-types";
import { isBase58Of } from "@/lib/base58";
import { buildPartnerClaimTxs, loadPartnerFees } from "@/lib/dbc/partner-fees";
import { lamportsToSol } from "@/lib/dbc/units";
import { getChain } from "./chain";
import { UserError } from "./errors";
import { PRIORITY_FEE_RPC_CALLS, toPreparedTx } from "./prepare-tx";

/**
 * Claim transactions handed out per request. One, so each is signed with a fresh blockhash (a
 * batch would expire while earlier ones confirm); the page asks again for the rest.
 */
export const MAX_CLAIM_TXS = 1;
/** RPC calls: the config and every pool on it (one getProgramAccounts). */
export const SUMMARY_RPC_CALLS = 4;
/** A claim build adds the coin-account check and, per transaction, blockhash + priority fee. */
export const CLAIM_RPC_CALLS = SUMMARY_RPC_CALLS + 1 + MAX_CLAIM_TXS * (1 + PRIORITY_FEE_RPC_CALLS);

/** MEMESTREAM_ADMIN_WALLETS: a comma list; entries that aren't addresses are ignored. */
export const isAdmin = (wallet: string) =>
  (process.env.MEMESTREAM_ADMIN_WALLETS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => isBase58Of(w, 32))
    .includes(wallet);

export type PartnerFeesSummary = {
  feeClaimer: string;
  /** The signed-in wallet is the fee claimer, so it can sign the claims. */
  canClaim: boolean;
  claimableSol: string;
  coinsWithFees: number;
  coins: number;
};

export async function partnerFeesSummary(wallet: string): Promise<PartnerFeesSummary> {
  const { client, config } = getChain();
  const fees = await loadPartnerFees(client, config);
  return {
    feeClaimer: fees.feeClaimer.toBase58(),
    canClaim: fees.feeClaimer.toBase58() === wallet,
    claimableSol: lamportsToSol(fees.totalLamports),
    coinsWithFees: fees.pools.length,
    coins: fees.poolCount,
  };
}

/** Up to MAX_CLAIM_TXS unsigned claim transactions; `more` if fees remain after them. */
export async function buildPartnerClaimsFor(wallet: string): Promise<{ transactions: PreparedTx[]; more: boolean }> {
  const { client, config } = getChain();
  const fees = await loadPartnerFees(client, config);
  if (fees.feeClaimer.toBase58() !== wallet) throw new UserError("Sign in with the config's fee claimer wallet to claim");
  if (fees.pools.length === 0) throw new UserError("Nothing to claim yet");
  const built = await buildPartnerClaimTxs(client, fees, new PublicKey(wallet), MAX_CLAIM_TXS + 1);
  const transactions: PreparedTx[] = [];
  for (const tx of built.slice(0, MAX_CLAIM_TXS)) transactions.push(await toPreparedTx(tx));
  return { transactions, more: built.length > MAX_CLAIM_TXS };
}
