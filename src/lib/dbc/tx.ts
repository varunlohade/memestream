/** The one shape every transaction builder returns, so callers sign the same way every time. */
import type { Keypair, PublicKey, Transaction } from "@solana/web3.js";

export type BuiltTx = {
  /** Unsigned; `feePayer` is already set. */
  tx: Transaction;
  /** The wallet that pays and must sign (the user's wallet in the app). */
  feePayer: PublicKey;
  /**
   * Fresh keypairs the builder created (new mint, config, position NFTs).
   * Partial-sign with these first, then ask the wallet to sign.
   */
  localSigners: Keypair[];
};

export function built(tx: Transaction, feePayer: PublicKey, localSigners: Keypair[] = []): BuiltTx {
  tx.feePayer = feePayer;
  return { tx, feePayer, localSigners };
}
