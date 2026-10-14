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
  derivePositionNftAccount,
  getAllPositionNftAccountByOwner,
  getTokenProgram,
  getUnClaimLpFee,
  positionByPoolFilter,
  type PoolState,
  type PositionState,
} from "@meteora-ag/cp-amm-sdk";
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { type Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { accountReadCalls, getAccountsChunked } from "../accounts";
import { chunks } from "../chunks";
import { InputError } from "../dbc/errors";
import { built, type BuiltTx } from "../dbc/tx";

export type LpPosition = { position: PublicKey; positionNftAccount: PublicKey; positionState: PositionState };

/** Position NFTs read per call in the fallback wallet scan (the first page is in callers' budgets). */
const MAX_POSITION_NFTS = 50;
/** The most position NFTs one wallet scan checks (10 reads); past it, the scan refuses, never truncates. */
export const MAX_SCANNED_NFTS = 500;
/**
 * The positions `owner` holds in `pool`. The pool's own positions are found first (graduation
 * makes two: streamer and platform), then each position's NFT account is checked for `owner`.
 * Junk token accounts in a wallet can't hide a position this way. Only if a position's NFT has
 * left its original account (the holder transferred it) does this also scan the wallet's position
 * NFTs (capped) and merge what it finds. Usually 2 RPC calls.
 */
export async function lpPositionsOf(
  connection: Connection,
  pool: PublicKey,
  owner: PublicKey,
  /**
   * Called (and awaited) before reads beyond what callers budget for: one more call per extra 100
   * positions in the pool, and per extra 50 NFTs in a wallet scan (callers already budget the first
   * read of each). May throw.
   */
  chargeExtraCalls: (calls: number) => Promise<void> = async () => {},
): Promise<LpPosition[]> {
  const program = new CpAmm(connection)._program;
  const inPool = (await program.account.position.all([positionByPoolFilter(pool)])) as PoolPosition[];
  return heldPositions(connection, inPool, owner, chargeExtraCalls, () => walletScan(connection, pool, owner, chargeExtraCalls));
}

type PoolPosition = { publicKey: PublicKey; account: PositionState };

/** Which of the pool's positions `owner` holds (lpPositionsOf after the pool read; exported for tests). */
export async function heldPositions(
  connection: Pick<Connection, "getMultipleAccountsInfo">,
  inPool: PoolPosition[],
  owner: PublicKey,
  chargeExtraCalls: (calls: number) => Promise<void>,
  scanWallet: () => Promise<LpPosition[]>,
): Promise<LpPosition[]> {
  if (inPool.length === 0) return [];
  const extraReads = accountReadCalls(inPool.length) - 1;
  if (extraReads > 0) await chargeExtraCalls(extraReads);
  const nftAccounts = inPool.map((p) => derivePositionNftAccount(p.account.nftMint));
  // A pool can hold more than 100 positions (anyone can open one), so read in chunks.
  const infos = await getAccountsChunked(connection, nftAccounts);

  const held: LpPosition[] = [];
  let anyMoved = false;
  inPool.forEach((p, i) => {
    const holder = nftHolder(infos[i]?.data);
    if (!holder) anyMoved = true;
    else if (holder.equals(owner)) held.push({ position: p.publicKey, positionNftAccount: nftAccounts[i], positionState: p.account });
  });
  if (!anyMoved) return held;
  // Some NFT left its original account: it may be this wallet's, in another token account. Scan
  // the wallet and merge, so a moved position is never dropped next to one still in place.
  const scanned = await scanWallet();
  const seen = new Set(held.map((p) => p.position.toBase58()));
  return [...held, ...scanned.filter((p) => !seen.has(p.position.toBase58()))];
}

/** The owner of a token account holding exactly 1 (an NFT), or null. Token account: mint 0..32, owner 32..64, amount u64 @64. */
function nftHolder(data: Buffer | undefined): PublicKey | null {
  if (!data || data.length < 72 || data.readBigUInt64LE(64) !== BigInt(1)) return null;
  return new PublicKey(data.subarray(32, 64));
}

/** Fallback for transferred NFTs: every position NFT in the wallet (any pool), then their positions. */
async function walletScan(connection: Connection, pool: PublicKey, owner: PublicKey, chargeExtraCalls: (calls: number) => Promise<void>): Promise<LpPosition[]> {
  const nfts = await getAllPositionNftAccountByOwner(connection, owner);
  const program = new CpAmm(connection)._program;
  return scanPositionNfts(
    nfts,
    pool,
    (addresses) => program.account.position.fetchMultiple(addresses) as Promise<(PositionState | null)[]>,
    chargeExtraCalls,
  );
}

type PositionNft = { positionNft: PublicKey; positionNftAccount: PublicKey };

/**
 * The wallet's positions in `pool`, from its position NFTs (exported for tests). NFTs of other
 * pools come first in no set order, so every NFT is checked, MAX_POSITION_NFTS per read, never
 * just the first page. Past MAX_SCANNED_NFTS it refuses rather than answer with a partial list.
 */
export async function scanPositionNfts(
  nfts: PositionNft[],
  pool: PublicKey,
  fetchPositions: (addresses: PublicKey[]) => Promise<(PositionState | null)[]>,
  chargeExtraCalls: (calls: number) => Promise<void>,
): Promise<LpPosition[]> {
  if (nfts.length > MAX_SCANNED_NFTS) throw new InputError(`This wallet holds over ${MAX_SCANNED_NFTS} LP position NFTs; we can't check them all`);
  const pages = chunks(nfts, MAX_POSITION_NFTS);
  if (pages.length > 1) await chargeExtraCalls(pages.length - 1);
  const found: LpPosition[] = [];
  for (const page of pages) {
    const addresses = page.map((nft) => derivePositionAddress(nft.positionNft));
    const states = await fetchPositions(addresses);
    page.forEach((nft, i) => {
      const positionState = states[i];
      if (positionState?.pool.equals(pool)) found.push({ position: addresses[i], positionNftAccount: nft.positionNftAccount, positionState });
    });
  }
  return found;
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
