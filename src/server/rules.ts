/**
 * memestream's app rules. Enforced by this server (and mirrored in the UI), not on-chain:
 * DBC swaps are open to anyone, so another wallet can still trade directly.
 */
import type { PublicKey } from "@solana/web3.js";
import { UserError } from "./errors";

export const SELF_BUY_MESSAGE = "memestream won't let a streamer's wallet buy their own coin";

/** A streamer's wallet can't buy their own coin here. Selling and claiming stay allowed. */
export function assertNotSelfBuy(side: "buy" | "sell", creator: PublicKey, trader: PublicKey) {
  if (side === "buy" && creator.equals(trader)) throw new UserError(SELF_BUY_MESSAGE);
}
