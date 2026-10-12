/**
 * Prediction markets, server side. Two kinds of work:
 * - For a user's wallet: quotes, bets (buy/sell YES or NO) and redeeming, built unsigned like the
 *   coin trades in transactions.ts. These need only the oracle's public key.
 * - As the oracle (memestream's server key): create a market, close its trading, resolve it, and
 *   redeem the oracle's own tokens. These sign with the key and send.
 *
 * Env: MEMESTREAM_MARKET_ORACLE (public key) for everything; MEMESTREAM_MARKET_ORACLE_KEY (the
 * secret key as a JSON byte array, like a solana-keygen file) only where the oracle acts.
 */
import "server-only";
import { Keypair, PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import type { PreparedTx, TradePreview } from "@/lib/api-types";
import type { DammQuote } from "@/lib/damm/trade";
import { formatUnits, lamportsToSol, parseUnits, solToLamports } from "@/lib/dbc/units";
import type { BuiltTx } from "@/lib/dbc/tx";
import { buildCreateMarketTxs } from "@/lib/markets/create";
import type { MarketOdds, Outcome, Side } from "@/lib/markets/math";
import { isPredictionId } from "@/lib/markets/math";
import { loadMarketPools, type MarketKeys, marketKeys, marketOdds, type MarketPools, OUTCOME_DECIMALS } from "@/lib/markets/pool";
import { buildCloseTradingTxs, buildRedeemTx, buildResolveTx } from "@/lib/markets/settle";
import { isTradingOpen, type MarketOrder, prepareMarketTrade, quoteMarketTrade } from "@/lib/markets/trade";
import { fetchQuestion } from "@/lib/markets/vault";
import { pollUntil } from "@/lib/poll";
import { parseTicker } from "@/lib/short-link";
import { getChain, rememberBuilt, signatureStatus } from "./chain";
import { asUserFacing, UserError } from "./errors";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

const oraclePublicKey = () => new PublicKey(requireEnv("MEMESTREAM_MARKET_ORACLE"));

/** The oracle's keypair. Never logged; a mismatch with the public key is a config error. */
function oracleKeypair(): Keypair {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(requireEnv("MEMESTREAM_MARKET_ORACLE_KEY")) as number[]));
  if (!keypair.publicKey.equals(oraclePublicKey())) throw new Error("MEMESTREAM_MARKET_ORACLE_KEY doesn't match MEMESTREAM_MARKET_ORACLE");
  return keypair;
}

/** Same as transactions.ts: fresh blockhash, partial-sign with builder keypairs, remember, serialize. */
async function toPreparedTx(built: BuiltTx): Promise<PreparedTx> {
  const { blockhash } = await getChain().connection.getLatestBlockhash("confirmed");
  built.tx.recentBlockhash = blockhash;
  if (built.localSigners.length) built.tx.partialSign(...built.localSigners);
  rememberBuilt(built.tx);
  const bytes = built.tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return { transaction: bytes.toString("base64"), blockhash };
}

async function userFacing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asUserFacing(error);
  }
}

function publicKey(address: string, what: string): PublicKey {
  try {
    return new PublicKey(address);
  } catch {
    throw new UserError(`Not a valid ${what} address`);
  }
}

export type MarketRef = { mint: string; predictionId: string };

function keysFor(ref: MarketRef): MarketKeys {
  if (!isPredictionId(ref.predictionId)) throw new UserError("Not a valid prediction id");
  return marketKeys(getChain().connection, publicKey(ref.mint, "coin"), ref.predictionId, oraclePublicKey());
}

async function poolsFor(keys: MarketKeys): Promise<MarketPools> {
  const pools = await loadMarketPools(getChain().connection, keys);
  if (!pools) throw new UserError("No market for this prediction");
  return pools;
}

export type MarketView = MarketOdds & { trading: boolean; resolved: boolean; payoutNumerators: number[] | null };

/** Odds and state of a market: open for bets, closed, or resolved (and how it paid). */
export async function getMarket(ref: MarketRef): Promise<MarketView> {
  return userFacing(async () => {
    const keys = keysFor(ref);
    const [pools, question] = await Promise.all([poolsFor(keys), fetchQuestion(getChain().connection, keys.question)]);
    return {
      ...marketOdds(pools),
      trading: isTradingOpen(pools),
      resolved: question?.resolved ?? false,
      payoutNumerators: question?.resolved ? question.numerators : null,
    };
  });
}

export type MarketQuoteRequest = MarketRef & { side: Side; action: "buy" | "sell"; amount: string; slippageBps: number };
/** `minReceived`: the minimum the user saw in the preview, so the bet can't fill worse. */
export type MarketTradeRequest = MarketQuoteRequest & { wallet: string; minReceived?: string };

const toTokens = (amount: BN) => formatUnits(amount, OUTCOME_DECIMALS);

function orderOf(req: MarketQuoteRequest): MarketOrder {
  return { side: req.side, action: req.action, amount: req.action === "buy" ? solToLamports(req.amount) : parseUnits(req.amount, OUTCOME_DECIMALS) };
}

function previewOf(order: MarketOrder, quote: DammQuote): TradePreview {
  const [fmtIn, fmtOut] = order.action === "buy" ? [lamportsToSol, toTokens] : [toTokens, lamportsToSol];
  return { spent: fmtIn(quote.spentAmount), received: fmtOut(quote.outputAmount), minimumReceived: fmtOut(quote.minimumAmountOut), partial: false };
}

export async function previewMarketTrade(req: MarketQuoteRequest): Promise<TradePreview> {
  return userFacing(async () => {
    const order = orderOf(req);
    return previewOf(order, quoteMarketTrade(await poolsFor(keysFor(req)), order, req.slippageBps));
  });
}

function minimumSeen(order: MarketOrder, minReceived: string | undefined): BN | undefined {
  if (minReceived === undefined) return undefined;
  try {
    return order.action === "buy" ? parseUnits(minReceived, OUTCOME_DECIMALS) : solToLamports(minReceived);
  } catch {
    throw new UserError("Not a valid minimum amount");
  }
}

export async function buildMarketTradeForWallet(req: MarketTradeRequest): Promise<PreparedTx & { preview: TradePreview }> {
  return userFacing(async () => {
    const order = orderOf(req);
    const keys = keysFor(req);
    const trader = publicKey(req.wallet, "wallet");
    const built = await prepareMarketTrade(getChain().connection, await poolsFor(keys), trader, order, req.slippageBps, minimumSeen(order, req.minReceived));
    return { ...(await toPreparedTx(built)), preview: previewOf(order, built.quote) };
  });
}

export async function buildMarketRedeemForWallet(req: MarketRef & { wallet: string }): Promise<PreparedTx> {
  return userFacing(async () => toPreparedTx(await buildRedeemTx(getChain().connection, keysFor(req), publicKey(req.wallet, "wallet"))));
}

// ---- The oracle's own actions: signed with the server key and sent. ----

const CONFIRM = { timeoutMs: 60_000, intervalMs: 500 };

/** Signs as the oracle (plus any builder keypairs), sends, and waits; throws unless it confirmed. */
async function sendAsOracle(built: BuiltTx, oracle: Keypair): Promise<string> {
  const { connection } = getChain();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  built.tx.recentBlockhash = blockhash;
  built.tx.sign(oracle, ...built.localSigners);
  const signature = await connection.sendRawTransaction(built.tx.serialize());
  const outcome = await pollUntil(async () => {
    const result = await signatureStatus(connection, { signature, blockhash });
    return result.status === "pending" ? undefined : result;
  }, CONFIRM);
  if (outcome?.status !== "confirmed") throw new Error(`Market transaction ${outcome?.status ?? "unconfirmed"}: ${outcome?.error ?? signature}`);
  return signature;
}

async function sendAllAsOracle(txs: BuiltTx[]): Promise<string[]> {
  const oracle = oracleKeypair();
  const signatures: string[] = [];
  for (const tx of txs) signatures.push(await sendAsOracle(tx, oracle));
  return signatures;
}

export type CreateMarketRequest = MarketRef & { ticker: string; seedSolPerPool: string };

/**
 * Creates and seeds a market (4 transactions). YES/NO tokens are named "$TICKER #id YES" so
 * wallets show what they are.
 */
export async function createMarket(req: CreateMarketRequest): Promise<string[]> {
  const keys = keysFor(req);
  const ticker = parseTicker(req.ticker);
  if (!ticker) throw new UserError("Ticker: 1 to 10 letters or digits");
  // Fits Metaplex's 32-character name: "$" + 10 + " #" + 9 + " YES".
  const names = (side: Side) => ({ name: `$${ticker} #${req.predictionId} ${side.toUpperCase()}`, symbol: side.toUpperCase(), uri: "" });
  return sendAllAsOracle(await buildCreateMarketTxs(getChain().connection, keys, { yes: names("yes"), no: names("no") }, solToLamports(req.seedSolPerPool)));
}

/** When betting closes: the oracle takes its liquidity out of both pools, so no more trades fill. */
export async function closeMarketTrading(ref: MarketRef): Promise<string[]> {
  const keys = keysFor(ref);
  return sendAllAsOracle(await buildCloseTradingTxs(getChain().connection, keys, await poolsFor(keys)));
}

/** After the off-chain flow settles: YES, NO, or refund (disputed or cancelled). */
export async function resolveMarket(ref: MarketRef & { outcome: Outcome }): Promise<string> {
  const [signature] = await sendAllAsOracle([await buildResolveTx(getChain().connection, keysFor(ref), ref.outcome)]);
  return signature;
}

/** The oracle redeems the YES/NO its liquidity came back as. */
export async function redeemOracleTokens(ref: MarketRef): Promise<string> {
  const [signature] = await sendAllAsOracle([await buildRedeemTx(getChain().connection, keysFor(ref), oraclePublicKey())]);
  return signature;
}
