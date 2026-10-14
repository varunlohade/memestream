/**
 * Write-side of the app: builds transactions for the user's wallet to sign.
 * The server never holds user keys. It only partial-signs with throwaway keypairs it just
 * made (a new coin's mint, position NFTs), then hands the bytes to the browser.
 */
import "server-only";
import { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import type { PreparedTx, TradePreview } from "@/lib/api-types";
import { buildClaimEarningsTx } from "@/lib/dbc/fees";
import { buildGraduateTx } from "@/lib/dbc/graduate";
import { buildCreateStreamCoinTx } from "@/lib/dbc/launch";
import { loadPoolSnapshot, type PoolSnapshot } from "@/lib/dbc/pool";
import { prepareTrade, quoteTrade, type TradeInput } from "@/lib/dbc/trade";
import { type DammSnapshot, graduatedPoolAddress, isCoinSolPool, loadDammSnapshot } from "@/lib/damm/pool";
import { prepareDammTrade, quoteDammTrade } from "@/lib/damm/trade";
import { buildClaimPoolFeesTx, lpPositionsOf } from "@/lib/damm/positions";
import type { BuiltTx } from "@/lib/dbc/tx";
import { baseUnitsToCoins, coinsToBaseUnits, lamportsToSol, solToLamports } from "@/lib/dbc/units";
import { coinForTicker, parseTicker } from "@/lib/short-link";
import { metadataUri, parseStreamLink } from "@/lib/stream-link";
import { UNVERIFIED_BUY_MESSAGE, UNVERIFIED_MAX_BUY_SOL } from "@/lib/unverified";
import { getChain, poolForMint, rememberBuilt } from "./chain";
import { listCoins } from "./coins";
import { asUserFacing, UserError } from "./errors";
import { assertCanLaunch, inviteSettings, isSealed } from "./invites";
import { loadMetadata } from "./metadata";
import { assertNotSelfBuy } from "./rules";

async function toPreparedTx(built: BuiltTx): Promise<PreparedTx> {
  const { connection } = getChain();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  built.tx.recentBlockhash = blockhash;
  if (built.localSigners.length) built.tx.partialSign(...built.localSigners);
  rememberBuilt(built.tx);
  const bytes = built.tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return { transaction: bytes.toString("base64"), blockhash };
}

/** Runs a build step, turning library input/state errors into user-facing ones. */
async function userFacing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asUserFacing(error);
  }
}

function walletKey(address: string): PublicKey {
  try {
    return new PublicKey(address);
  } catch {
    throw new UserError("Not a valid wallet address");
  }
}

async function snapshotForMint(mint: string) {
  const pool = poolForMint(mint);
  if (!pool) throw new UserError("Not a valid coin address");
  try {
    return await loadPoolSnapshot(getChain().client, pool);
  } catch (error) {
    if ((error as Error).message.startsWith("Pool not found")) throw new UserError("Coin not found");
    throw error;
  }
}

export type LaunchRequest = { wallet: string; name: string; symbol: string; streamUrl?: string };

export async function buildLaunchForWallet(req: LaunchRequest): Promise<PreparedTx & { mint: string }> {
  const { client, config, publicUrl } = getChain();
  // Invited YouTube channels only for now (see invites.ts); open mode, for testing, also takes Twitch.
  // Kick's ad policy bans meme-coins.
  const settings = inviteSettings();
  const link = parseStreamLink(req.streamUrl ?? "");
  const platforms = settings.mode === "open" ? ["youtube", "twitch"] : ["youtube"];
  if (!link || !platforms.includes(link.platform)) {
    throw new UserError(settings.mode === "open" ? "Paste your YouTube or Twitch live link" : "Paste your YouTube live link");
  }
  // The ticker is the overlay's short link (/<ticker>): letters and digits only, and the first
  // verified coin keeps it. This check is best effort (launches straight to the program skip it);
  // coinForTicker still sends the link to the right coin.
  const symbol = parseTicker(req.symbol);
  if (!symbol) throw new UserError("Ticker: 1 to 10 letters or digits");
  const wallet = walletKey(req.wallet);
  const coins = await listCoins();
  // Unverified coins can't block a verified streamer's ticker (coinForTicker prefers verified ones).
  const taken = coinForTicker(coins, symbol);
  if (taken && (taken.verified || settings.mode === "open")) throw new UserError(`$${symbol} is taken. Pick another ticker`);
  // One verified coin per stream. Best effort, like the ticker check.
  if (coins.some((coin) => coin.verified && coin.streamUrl === link.url)) throw new UserError("This stream already has a coin");
  const seal = await assertCanLaunch(settings, wallet.toBase58(), link);
  return userFacing(async () => {
    const built = await buildCreateStreamCoinTx(
      client,
      {
        name: req.name,
        symbol,
        uri: (mint) => metadataUri(publicUrl, mint.toBase58(), link, seal?.(mint.toBase58())),
      },
      { config, creator: wallet },
    );
    return { ...(await toPreparedTx(built)), mint: built.mint.toBase58() };
  });
}

/** One metadata read: does this coin carry our seal? */
async function isVerifiedCoin(mint: string): Promise<boolean> {
  const [meta] = await loadMetadata(getChain().connection, [new PublicKey(mint)]);
  return Boolean(meta && isSealed(inviteSettings().secret, mint, meta.uri));
}

export type QuoteRequest = { mint: string; side: "buy" | "sell"; amount: string; slippageBps: number };
/** `minReceived`: the minimum the user saw in the preview (output units), so the trade can't fill worse. */
export type TradeRequest = QuoteRequest & { wallet: string; minReceived?: string };

function tradeInput(side: "buy" | "sell", amount: string): TradeInput {
  return side === "buy" ? { side, lamports: solToLamports(amount) } : { side, baseUnits: coinsToBaseUnits(amount) };
}

/** What a preview needs from either kind of quote (the curve's, or the graduated pool's). */
type QuoteAmounts = { spentAmount: BN; outputAmount: BN; minimumAmountOut: BN };

function previewOf(input: TradeInput, quote: QuoteAmounts): TradePreview {
  const [fmtIn, fmtOut] = input.side === "buy" ? [lamportsToSol, baseUnitsToCoins] : [baseUnitsToCoins, lamportsToSol];
  const asked = input.side === "buy" ? input.lamports : input.baseUnits;
  return {
    spent: fmtIn(quote.spentAmount),
    received: fmtOut(quote.outputAmount),
    minimumReceived: fmtOut(quote.minimumAmountOut),
    partial: quote.spentAmount.lt(asked),
  };
}

/** A graduated coin trades in its Meteora DAMM v2 pool, found from the coin's config and mint. */
async function graduatedPool(snapshot: PoolSnapshot): Promise<DammSnapshot> {
  const address = graduatedPoolAddress(snapshot.config, snapshot.pool.poolState.baseMint);
  const pool = await loadDammSnapshot(getChain().connection, address);
  if (!pool) throw new UserError("This coin's Meteora pool isn't open yet. Try again in a moment.");
  // Trade direction and price assume coin = token A, SOL = token B; never trade a pool that differs.
  if (!isCoinSolPool(pool.state, snapshot.pool.poolState.baseMint)) throw new Error(`Unexpected Meteora pool layout at ${address.toBase58()}`);
  return pool;
}

/** Read-only price check for the trade box; needs no wallet. Uses the curve, or the Meteora pool once graduated. */
export async function previewTrade(req: QuoteRequest): Promise<TradePreview> {
  return userFacing(async () => {
    const input = tradeInput(req.side, req.amount);
    const snapshot = await snapshotForMint(req.mint);
    const quote =
      snapshot.status === "graduated"
        ? quoteDammTrade(await graduatedPool(snapshot), input, req.slippageBps)
        : quoteTrade(snapshot, input, req.slippageBps);
    return previewOf(input, quote);
  });
}

/** The preview's minimum in base units (coins for a buy, lamports for a sell); none if absent. */
function minimumSeen(side: "buy" | "sell", minReceived: string | undefined): BN | undefined {
  if (minReceived === undefined) return undefined;
  try {
    return side === "buy" ? coinsToBaseUnits(minReceived) : solToLamports(minReceived);
  } catch {
    throw new UserError("Not a valid minimum amount");
  }
}

export async function buildTradeForWallet(req: TradeRequest): Promise<PreparedTx & { preview: TradePreview }> {
  const { client } = getChain();
  return userFacing(async () => {
    const input = tradeInput(req.side, req.amount);
    const trader = walletKey(req.wallet);
    const snapshot = await snapshotForMint(req.mint);
    assertNotSelfBuy(input.side, snapshot.pool.poolState.creator, trader);
    if (input.side === "buy" && input.lamports.gt(solToLamports(UNVERIFIED_MAX_BUY_SOL)) && !(await isVerifiedCoin(req.mint))) {
      throw new UserError(UNVERIFIED_BUY_MESSAGE);
    }
    const floor = minimumSeen(input.side, req.minReceived);
    const built =
      snapshot.status === "graduated"
        ? await prepareDammTrade(client.connection, await graduatedPool(snapshot), trader, input, req.slippageBps, floor)
        : await prepareTrade(client, snapshot, trader, input, req.slippageBps, floor);
    return { ...(await toPreparedTx(built)), preview: previewOf(input, built.quote) };
  });
}

export async function buildClaimForWallet(req: { wallet: string; mint: string }): Promise<PreparedTx> {
  const { client } = getChain();
  return userFacing(async () => toPreparedTx(await buildClaimEarningsTx(client, await snapshotForMint(req.mint), walletKey(req.wallet))));
}

/** Claims the pool fees on an LP position NFT the wallet holds in a graduated coin's Meteora pool. */
export async function buildClaimPoolFeesForWallet(req: { wallet: string; mint: string }): Promise<PreparedTx> {
  const { connection } = getChain();
  return userFacing(async () => {
    const snapshot = await snapshotForMint(req.mint);
    if (snapshot.status !== "graduated") throw new UserError("Pool fees start once the coin graduates");
    const pool = await graduatedPool(snapshot);
    const owner = walletKey(req.wallet);
    const positions = await lpPositionsOf(connection, pool.address, owner);
    return toPreparedTx(await buildClaimPoolFeesTx(connection, pool, owner, positions));
  });
}

export async function buildGraduateForWallet(req: { wallet: string; mint: string }): Promise<PreparedTx> {
  const { client } = getChain();
  return userFacing(async () => toPreparedTx(await buildGraduateTx(client, await snapshotForMint(req.mint), walletKey(req.wallet))));
}
