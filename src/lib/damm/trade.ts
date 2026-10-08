/**
 * Buying and selling a graduated coin in its DAMM v2 pool. Same inputs and money rules as the curve
 * (lib/dbc/trade.ts): exact-in swaps, a fixed slippage cap, a minimum that's never zero, and the
 * minimum the user saw as a floor that can only make a trade stricter.
 */
import { CpAmm, getTokenProgram, SwapMode, swapQuoteExactInput } from "@meteora-ag/cp-amm-sdk";
import type { Connection, PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import { InputError } from "../dbc/errors";
import { MAX_SLIPPAGE_BPS, type TradeInput } from "../dbc/trade";
import { built, type BuiltTx } from "../dbc/tx";
import { BASE_DECIMALS, QUOTE } from "../dbc/units";
import type { DammSnapshot } from "./pool";

export type DammQuote = {
  /** Input spent: always all of it (no partial fills after graduation). */
  spentAmount: BN;
  outputAmount: BN;
  /** Output after slippage; the swap fails on-chain if it would get less. Never zero. */
  minimumAmountOut: BN;
};

const amountOf = (input: TradeInput) => (input.side === "buy" ? input.lamports : input.baseUnits);

/** Buys put SOL (token B) in and take the coin (token A) out; sells the other way. */
function mintsFor(snapshot: DammSnapshot, input: TradeInput) {
  const { tokenAMint, tokenBMint } = snapshot.state;
  return input.side === "buy" ? { inputMint: tokenBMint, outputMint: tokenAMint } : { inputMint: tokenAMint, outputMint: tokenBMint };
}

export function quoteDammTrade(snapshot: DammSnapshot, input: TradeInput, slippageBps: number): DammQuote {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new InputError(`Slippage must be 0 to ${MAX_SLIPPAGE_BPS} bps`);
  }
  const amountIn = amountOf(input);
  if (amountIn.lten(0)) throw new InputError("Amount must be more than 0");
  const { state } = snapshot;
  const aToB = mintsFor(snapshot, input).inputMint.equals(state.tokenAMint);
  // Plain SPL mints on both sides (no transfer fees), so no token-2022 info is needed.
  const quote = swapQuoteExactInput(state, snapshot.currentPoint, amountIn, slippageBps, aToB, false, BASE_DECIMALS, QUOTE.decimals);
  const minimumAmountOut = quote.minimumAmountOut;
  if (!minimumAmountOut || minimumAmountOut.isZero()) {
    throw new InputError("Amount too small: you would get nothing back");
  }
  return { spentAmount: amountIn, outputAmount: quote.outputAmount, minimumAmountOut };
}

/**
 * Quotes and builds the matching swap in one step. `atLeast` is the minimum the user saw: the
 * swap's minimum is the stricter of that and this fresh quote's.
 */
export async function prepareDammTrade(
  connection: Connection,
  snapshot: DammSnapshot,
  trader: PublicKey,
  input: TradeInput,
  slippageBps: number,
  atLeast?: BN,
): Promise<BuiltTx & { quote: DammQuote }> {
  const fresh = quoteDammTrade(snapshot, input, slippageBps);
  const quote = atLeast?.gt(fresh.minimumAmountOut) ? { ...fresh, minimumAmountOut: atLeast } : fresh;
  const { state } = snapshot;
  const { inputMint, outputMint } = mintsFor(snapshot, input);
  const tx = await new CpAmm(connection).swap2({
    payer: trader,
    pool: snapshot.address,
    inputTokenMint: inputMint,
    outputTokenMint: outputMint,
    tokenAMint: state.tokenAMint,
    tokenBMint: state.tokenBMint,
    tokenAVault: state.tokenAVault,
    tokenBVault: state.tokenBVault,
    tokenAProgram: getTokenProgram(state.tokenAFlag),
    tokenBProgram: getTokenProgram(state.tokenBFlag),
    referralTokenAccount: null,
    poolState: state,
    swapMode: SwapMode.ExactIn,
    amountIn: amountOf(input),
    minimumAmountOut: quote.minimumAmountOut,
  });
  return { ...built(tx, trader), quote };
}
