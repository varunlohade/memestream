/** Streamer earnings: the creator's share of trading fees on their coin, paid in SOL. */
import { type DynamicBondingCurveClient, U64_MAX } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { InputError } from "./errors";
import type { PoolSnapshot } from "./pool";
import { type BuiltTx, built } from "./tx";

/** Lamports the streamer has earned and not yet claimed. Read from the snapshot; no RPC call. */
export const unclaimedStreamerFees = (snapshot: PoolSnapshot): BN => snapshot.pool.poolState.creatorQuoteFee;

/**
 * Claims everything the streamer has earned, to their own wallet. The cap is U64_MAX, so fees
 * that arrive between reading and sending are claimed too; the program pays out only what exists.
 * Fee payer and only signer: `streamer` (the pool creator).
 */
export async function buildClaimEarningsTx(
  client: DynamicBondingCurveClient,
  snapshot: PoolSnapshot,
  streamer: PublicKey,
): Promise<BuiltTx> {
  if (!snapshot.pool.poolState.creator.equals(streamer)) throw new InputError("Only the coin's streamer can claim");
  if (unclaimedStreamerFees(snapshot).isZero()) throw new InputError("Nothing to claim yet");
  const tx = await client.creator.claimCreatorTradingFee({
    creator: streamer,
    payer: streamer,
    pool: snapshot.address,
    // Fees are collected in SOL (the quote token), so there is never a base-token fee.
    maxBaseAmount: new BN(0),
    maxQuoteAmount: U64_MAX,
  });
  return built(tx, streamer);
}
