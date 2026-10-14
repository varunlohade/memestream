/**
 * Limits on coins whose launcher nobody has verified (see server/invites.ts). Enforced by our
 * server when it builds a trade and mirrored in the trade box. Meteora's program doesn't know
 * about them, so a wallet trading straight on-chain can skip them.
 */

/** The most SOL one buy of an unverified coin may spend here. Selling is never limited. */
export const UNVERIFIED_MAX_BUY_SOL = "0.1";

export const UNVERIFIED_BUY_MESSAGE = `Unverified coin: each buy is capped at ${UNVERIFIED_MAX_BUY_SOL} SOL`;
