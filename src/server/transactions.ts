/**
 * Write-side of the app: builds transactions for the user's wallet to sign.
 * The server never holds user keys. It only partial-signs with throwaway keypairs it just
 * made (a new coin's mint, position NFTs), then hands the bytes to the browser.
 */
import "server-only";
import { PublicKey } from "@solana/web3.js";
import type { PreparedTx, TradePreview } from "@/lib/api-types";
import { buildClaimEarningsTx } from "@/lib/dbc/fees";
import { buildGraduateTx } from "@/lib/dbc/graduate";
import { buildCreateStreamCoinTx } from "@/lib/dbc/launch";
import { loadPoolSnapshot } from "@/lib/dbc/pool";
import { prepareTrade, quoteTrade, type TradeInput, type TradeQuote } from "@/lib/dbc/trade";
import type { BuiltTx } from "@/lib/dbc/tx";
import { baseUnitsToCoins, coinsToBaseUnits, lamportsToSol, solToLamports } from "@/lib/dbc/units";
import { metadataUri, parseStreamLink } from "@/lib/stream-link";
import { getChain, poolForMint, rememberBuilt } from "./chain";
import { asUserFacing, UserError } from "./errors";
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
  // New coins stream on YouTube or Twitch (both embed reliably). Kick's ad policy bans meme-coins.
  const link = parseStreamLink(req.streamUrl ?? "");
  if (link?.platform !== "youtube" && link?.platform !== "twitch") {
    throw new UserError("Paste your YouTube or Twitch live link");
  }
  return userFacing(async () => {
    const built = await buildCreateStreamCoinTx(
      client,
      {
        name: req.name,
        symbol: req.symbol.replace(/^\$/, ""),
        uri: (mint) => metadataUri(publicUrl, mint.toBase58(), link),
      },
      { config, creator: walletKey(req.wallet) },
    );
    return { ...(await toPreparedTx(built)), mint: built.mint.toBase58() };
  });
}

export type QuoteRequest = { mint: string; side: "buy" | "sell"; amount: string; slippageBps: number };
export type TradeRequest = QuoteRequest & { wallet: string };

function tradeInput(side: "buy" | "sell", amount: string): TradeInput {
  return side === "buy" ? { side, lamports: solToLamports(amount) } : { side, baseUnits: coinsToBaseUnits(amount) };
}

function previewOf(input: TradeInput, quote: TradeQuote): TradePreview {
  const [fmtIn, fmtOut] = input.side === "buy" ? [lamportsToSol, baseUnitsToCoins] : [baseUnitsToCoins, lamportsToSol];
  const asked = input.side === "buy" ? input.lamports : input.baseUnits;
  return {
    spent: fmtIn(quote.spentAmount),
    received: fmtOut(quote.outputAmount),
    minimumReceived: fmtOut(quote.minimumAmountOut),
    partial: quote.spentAmount.lt(asked),
  };
}

/** Read-only price check for the trade box; needs no wallet. */
export async function previewTrade(req: QuoteRequest): Promise<TradePreview> {
  return userFacing(async () => {
    const input = tradeInput(req.side, req.amount);
    return previewOf(input, quoteTrade(await snapshotForMint(req.mint), input, req.slippageBps));
  });
}

export async function buildTradeForWallet(req: TradeRequest): Promise<PreparedTx & { preview: TradePreview }> {
  const { client } = getChain();
  return userFacing(async () => {
    const input = tradeInput(req.side, req.amount);
    const trader = walletKey(req.wallet);
    const snapshot = await snapshotForMint(req.mint);
    assertNotSelfBuy(input.side, snapshot.pool.poolState.creator, trader);
    const built = await prepareTrade(client, snapshot, trader, input, req.slippageBps);
    return { ...(await toPreparedTx(built)), preview: previewOf(input, built.quote) };
  });
}

export async function buildClaimForWallet(req: { wallet: string; mint: string }): Promise<PreparedTx> {
  const { client } = getChain();
  return userFacing(async () => toPreparedTx(await buildClaimEarningsTx(client, await snapshotForMint(req.mint), walletKey(req.wallet))));
}

export async function buildGraduateForWallet(req: { wallet: string; mint: string }): Promise<PreparedTx> {
  const { client } = getChain();
  return userFacing(async () => toPreparedTx(await buildGraduateTx(client, await snapshotForMint(req.mint), walletKey(req.wallet))));
}
