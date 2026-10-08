/** Reads a coin's trades out of parsed transactions. Pure (no RPC), so it unit-tests without a chain. */
import type { ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { TradeView } from "./api-types";
import { baseUnitsToCoins, lamportsToSol } from "./dbc/units";

/** The pool's two token vaults: SOL (quote) and the coin (base). */
export type PoolVaults = { quote: PublicKey; base: PublicKey };

type TokenBalances = { accountIndex: number; uiTokenAmount: { amount: string } }[] | null | undefined;
const vaultAmount = (balances: TokenBalances, index: number) =>
  new BN(balances?.find((b) => b.accountIndex === index)?.uiTokenAmount.amount ?? "0");

/**
 * One swap, read from the pool's vault balance changes: SOL into the quote vault is a buy.
 * Null for a failed transaction, and for launch, claim and graduation (they don't move both vaults).
 */
export function tradeFromTransaction(
  tx: ParsedTransactionWithMeta | null,
  signature: string,
  pool: { vaults: PoolVaults; creator: string },
): TradeView | null {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const quoteIndex = keys.indexOf(pool.vaults.quote.toBase58());
  const baseIndex = keys.indexOf(pool.vaults.base.toBase58());
  if (quoteIndex < 0 || baseIndex < 0) return null;
  const quoteDelta = vaultAmount(tx.meta.postTokenBalances, quoteIndex).sub(vaultAmount(tx.meta.preTokenBalances, quoteIndex));
  const baseDelta = vaultAmount(tx.meta.postTokenBalances, baseIndex).sub(vaultAmount(tx.meta.preTokenBalances, baseIndex));
  if (quoteDelta.isZero() || baseDelta.isZero()) return null;
  // A swap moves the vaults in opposite directions. Both up (graduation filling the new pool, or
  // anyone adding liquidity) or both down (removing liquidity, a two-token fee claim) is not a trade.
  if (quoteDelta.isNeg() === baseDelta.isNeg()) return null;

  const sol = lamportsToSol(quoteDelta.abs());
  const coins = baseUnitsToCoins(baseDelta.abs());
  const wallet = keys[0];
  return {
    signature,
    side: quoteDelta.gtn(0) ? "buy" : "sell",
    sol,
    coins,
    wallet,
    time: tx.blockTime ?? null,
    priceSol: Number(sol) / Number(coins),
    byStreamer: wallet === pool.creator,
  };
}
