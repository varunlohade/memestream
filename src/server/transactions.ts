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
import { baseUnitsToCoins, coinsToBaseUnits, lamportsToSol, solToLamports } from "@/lib/dbc/units";
import { coinForTicker, parseTicker } from "@/lib/short-link";
import { metadataUri, parseStreamLink } from "@/lib/stream-link";
import { getChain, poolForMint } from "./chain";
import { listCoins } from "./coins";
import { asUserFacing, UserError } from "./errors";
import { toPreparedTx } from "./prepare-tx";
import { assertNotSelfBuy } from "./rules";

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
  // New coins stream on YouTube or Twitch (both embed reliably). Kick's ad policy bans meme-coins.
  const link = parseStreamLink(req.streamUrl ?? "");
  if (link?.platform !== "youtube" && link?.platform !== "twitch") {
    throw new UserError("Paste your YouTube or Twitch live link");
  }
  // The ticker is the overlay's short link (/<ticker>): letters and digits only, and the first coin
  // keeps it. This check is best effort (launches straight to the program skip it); coinForTicker
  // still sends the link to the first coin.
  const symbol = parseTicker(req.symbol);
  if (!symbol) throw new UserError("Ticker: 1 to 10 letters or digits");
  if (coinForTicker(await listCoins(), symbol)) throw new UserError(`$${symbol} is taken. Pick another ticker`);
  return userFacing(async () => {
    const built = await buildCreateStreamCoinTx(
      client,
      {
        name: req.name,
        symbol,
        uri: (mint) => metadataUri(publicUrl, mint.toBase58(), link),
      },
      { config, creator: walletKey(req.wallet) },
    );
    return { ...(await toPreparedTx(built)), mint: built.mint.toBase58() };
  });
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
