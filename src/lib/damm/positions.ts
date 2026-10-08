/**
 * LP positions in a graduated coin's Meteora pool. Graduation mints two position NFTs, one for the
 * streamer and one for the platform, each holding permanently locked liquidity that keeps earning
 * the pool's trading fees. Whoever holds a position NFT can claim its fees; the liquidity itself
 * never unlocks.
 */
import {
  CollectFeeMode,
  CpAmm,
  derivePositionAddress,
  getAllPositionNftAccountByOwner,
  getTokenProgram,
  getUnClaimLpFee,
  type PoolState,
  type PositionState,
} from "@meteora-ag/cp-amm-sdk";
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { InputError } from "../dbc/errors";
import { built, type BuiltTx } from "../dbc/tx";

export type LpPosition = { position: PublicKey; positionNftAccount: PublicKey; positionState: PositionState };

/** Position NFTs read per wallet: bounds the work one request can cause (a holder of more claims from Meteora). */
const MAX_POSITION_NFTS = 50;

/**
 * The positions `owner` holds in `pool`, found from the position NFTs in its wallet (at most
 * MAX_POSITION_NFTS of them). Exactly two RPC calls: the wallet's NFT accounts, then their positions.
 */
export async function lpPositionsOf(connection: Connection, pool: PublicKey, owner: PublicKey): Promise<LpPosition[]> {
  const nfts = (await getAllPositionNftAccountByOwner(connection, owner)).slice(0, MAX_POSITION_NFTS);
  if (nfts.length === 0) return [];
  const addresses = nfts.map((nft) => derivePositionAddress(nft.positionNft));
  const states = (await new CpAmm(connection)._program.account.position.fetchMultiple(addresses)) as (PositionState | null)[];
  return nfts.flatMap((nft, i) => {
    const positionState = states[i];
    return positionState?.pool.equals(pool) ? [{ position: addresses[i], positionNftAccount: nft.positionNftAccount, positionState }] : [];
  });
}

/** Fees the positions can claim now: the coin side (token A) and the SOL side (token B). */
export function unclaimedPoolFees(state: PoolState, positions: LpPosition[]): { coins: BN; lamports: BN } {
  return positions.reduce(
    (sum, p) => {
      const fee = getUnClaimLpFee(state, p.positionState);
      return { coins: sum.coins.add(fee.feeTokenA), lamports: sum.lamports.add(fee.feeTokenB) };
    },
    { coins: new BN(0), lamports: new BN(0) },
  );
}

/**
 * Claims one position's fees to the holder's wallet (SOL unwrapped): the position with the most
 * SOL fees. One per transaction, because each claim brings its own token-account setup; a holder
 * of several positions claims again for the next.
 */
export async function buildClaimPoolFeesTx(
  connection: Connection,
  pool: { address: PublicKey; state: PoolState },
  owner: PublicKey,
  positions: LpPosition[],
): Promise<BuiltTx> {
  if (positions.length === 0) throw new InputError("This wallet holds no LP position in this coin's pool");
  const { state } = pool;
  const withFees = positions
    .map((p) => ({ p, fee: getUnClaimLpFee(state, p.positionState) }))
    .filter(({ fee }) => !fee.feeTokenA.isZero() || !fee.feeTokenB.isZero())
    .sort((a, b) => b.fee.feeTokenB.cmp(a.fee.feeTokenB));
  if (withFees.length === 0) throw new InputError("No pool fees to claim yet");
  const { p, fee } = withFees[0];
  // The claim creates the holder's coin token account if it's missing. When no coin fees come
  // (this pool pays fees in SOL), close that new empty account in the same transaction, so a
  // first claim doesn't spend ~0.002 SOL of rent on an account that stays empty.
  const coinProgram = getTokenProgram(state.tokenAFlag);
  const coinAccount = getAssociatedTokenAddressSync(state.tokenAMint, owner, true, coinProgram);
  // Only for pools that pay fees in SOL alone, so no coin fee can arrive between build and send.
  const closeEmptyCoinAccount =
    state.collectFeeMode === CollectFeeMode.OnlyB && fee.feeTokenA.isZero() && !(await connection.getAccountInfo(coinAccount));
  const tx = await new CpAmm(connection).claimPositionFee({
    owner,
    pool: pool.address,
    position: p.position,
    positionNftAccount: p.positionNftAccount,
    tokenAMint: state.tokenAMint,
    tokenBMint: state.tokenBMint,
    tokenAVault: state.tokenAVault,
    tokenBVault: state.tokenBVault,
    tokenAProgram: getTokenProgram(state.tokenAFlag),
    tokenBProgram: getTokenProgram(state.tokenBFlag),
  });
  if (closeEmptyCoinAccount) tx.add(createCloseAccountInstruction(coinAccount, owner, owner, [], coinProgram));
  return built(tx, owner);
}
