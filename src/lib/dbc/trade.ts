/** Buying and selling a stream coin on its curve. */
import {
  type DynamicBondingCurveClient,
  type SwapQuote2Result,
  SwapMode,
  swapQuotePartialFill,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import { InputError } from "./errors";
import type { PoolSnapshot } from "./pool";
import { type BuiltTx, built } from "./tx";

/** What the user asked for. Units differ by side, so they are named per side. */
export type TradeInput = { side: "buy"; lamports: BN } | { side: "sell"; baseUnits: BN };

/** A fixed cap so a typo can't produce a nonsense minimum. 5000 bps = 50%. */
export const MAX_SLIPPAGE_BPS = 5_000;

export type TradeQuote = SwapQuote2Result & {
  /** Output after slippage; the trade fails on-chain if it would get less. Never zero. */
  minimumAmountOut: BN;
  /**
   * Input actually spent. Can be less than asked: a buy that would overshoot the
   * graduation threshold is partly filled, and the rest stays in the wallet.
   */
  spentAmount: BN;
};

const amountOf = (input: TradeInput) => (input.side === "buy" ? input.lamports : input.baseUnits);
const isSell = (input: TradeInput) => input.side === "sell";

function assertSlippage(bps: number) {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
    throw new InputError(`Slippage must be a whole number of bps from 0 to ${MAX_SLIPPAGE_BPS}`);
  }
}

/**
 * Pure quote from a snapshot (no network). Uses partial fill so the last buy before
 * graduation succeeds instead of failing with "Insufficient Liquidity".
 */
export function quoteTrade(snapshot: PoolSnapshot, input: TradeInput, slippageBps: number): TradeQuote {
  assertSlippage(slippageBps);
  if (snapshot.status !== "trading") throw new InputError(`Coin is ${snapshot.status}; the curve is closed`);
  if (amountOf(input).lten(0)) throw new InputError("Amount must be more than zero");

  const quote = swapQuotePartialFill(
    snapshot.pool,
    snapshot.config,
    isSell(input),
    amountOf(input),
    slippageBps,
    false, // no referral
    snapshot.currentPoint,
    false, // the config disables the cheap first swap
  );
  const minimumAmountOut = quote.minimumAmountOut;
  if (!minimumAmountOut || minimumAmountOut.isZero()) {
    throw new InputError("Amount too small: you would get nothing back");
  }
  return { ...quote, minimumAmountOut, spentAmount: quote.includedFeeInputAmount };
}

/** Quotes and builds the matching swap in one step, so they can't disagree. */
export async function prepareTrade(
  client: DynamicBondingCurveClient,
  snapshot: PoolSnapshot,
  trader: PublicKey,
  input: TradeInput,
  slippageBps: number,
): Promise<BuiltTx & { quote: TradeQuote }> {
  const quote = quoteTrade(snapshot, input, slippageBps);
  const tx = await client.pool.swap2({
    owner: trader,
    pool: snapshot.address,
    swapBaseForQuote: isSell(input),
    swapMode: SwapMode.PartialFill,
    amountIn: amountOf(input),
    minimumAmountOut: quote.minimumAmountOut,
    referralTokenAccount: null,
  });
  return { ...built(tx, trader), quote };
}
