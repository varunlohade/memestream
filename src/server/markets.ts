/**
 * Prediction markets, server side. Two kinds of work:
 * - For a user's wallet: odds, quotes, bets (buy/sell YES or NO) and redeeming, built unsigned like
 *   the coin trades in transactions.ts. These work only on a registered market (a MarketRecord the
 *   predictions store wrote when the oracle created it), and check its pools on chain every time.
 * - As the oracle (memestream's server key): create a market, close its trading, resolve it, and
 *   redeem the oracle's own tokens. These sign with the key and send.
 *
 * Env (server only): MEMESTREAM_MARKET_ORACLE (public key); MEMESTREAM_MARKET_ORACLE_KEY (the secret
 * key as a JSON byte array, like a solana-keygen file) only where the oracle acts;
 * MEMESTREAM_MARKET_SECRET (32+ characters) keys question ids so nobody can squat a market's
 * addresses; MEMESTREAM_MARKET_METADATA=1 names the YES/NO mints (default off: it costs rent).
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { LIQUIDITY_SCALE } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import type { PreparedTx } from "@/lib/api-types";
import { formatUnits, lamportsToSol, parseUnits, solToLamports } from "@/lib/dbc/units";
import type { BuiltTx } from "@/lib/dbc/tx";
import { buildCreateMarketTxs, buildMarketMetadataTx } from "@/lib/markets/create";
import { isPredictionId, MIN_MARKET_SECRET_CHARS, type Outcome, type Side } from "@/lib/markets/math";
import { loadMarketPool, MARKET_FEE_BPS, type MarketKeys, marketKeys, marketKeysFromId, marketOdds, type MarketPool, OUTCOME_DECIMALS, verifyMarketPool } from "@/lib/markets/pool";
import { poolOwnership, positionNftFor } from "@/lib/markets/provenance";
import type { MarketPosition, MarketPreview, MarketRecord, MarketView } from "@/lib/markets/record";
import { buildCloseTradingTxs, buildRedeemTx, buildResolveTx } from "@/lib/markets/settle";
import { type MarketOrder, type MarketQuote, prepareMarketTrade, quoteMarketTrade } from "@/lib/markets/trade";
import { fetchQuestion, type QuestionState } from "@/lib/markets/vault";
import { pollUntil } from "@/lib/poll";
import { parseTicker } from "@/lib/short-link";
import { getChain, rememberBuilt, signatureStatus } from "./chain";
import { InputError } from "@/lib/dbc/errors";
import { asUserFacing, BusyError, UserError } from "./errors";
import { takeRpcBudget } from "./rpc-budget";

const SIDES: Side[] = ["yes", "no"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

const oraclePublicKey = () => new PublicKey(requireEnv("MEMESTREAM_MARKET_ORACLE"));

/** The oracle's keypair. Never logged: a key that doesn't parse gives a generic error, never its text. */
function oracleKeypair(): Keypair {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(requireEnv("MEMESTREAM_MARKET_ORACLE_KEY")) as number[]));
  } catch {
    throw new Error("Oracle key is not set up correctly");
  }
  if (!keypair.publicKey.equals(oraclePublicKey())) throw new Error("Oracle key is not set up correctly");
  return keypair;
}

/** DEV ONLY: without a configured secret, a random one per process (markets made before a restart can't be re-created). */
let devSecret: string | undefined;
function marketSecret(): string {
  const secret = process.env.MEMESTREAM_MARKET_SECRET ?? "";
  if (secret.length >= MIN_MARKET_SECRET_CHARS) return secret;
  if (process.env.NODE_ENV === "production") throw new Error("Markets are not set up (no MEMESTREAM_MARKET_SECRET)");
  return (devSecret ??= randomBytes(32).toString("hex"));
}

/**
 * Names on the YES/NO mints cost ~0.0275 SOL of rent per market, and on mainnet MetaDAO lets only its
 * deployer add them, so they're off unless MEMESTREAM_MARKET_METADATA=1. The app labels YES/NO itself.
 */
const metadataOn = () => process.env.MEMESTREAM_MARKET_METADATA === "1";

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

const NO_MARKET = "No market for this prediction";

/**
 * A registered market's keys, re-derived from its question id and our oracle: a record that
 * doesn't match what the oracle would have made (or names another oracle) is refused.
 */
function keysOf(record: MarketRecord): MarketKeys {
  const oracle = oraclePublicKey();
  if (record.oracle !== oracle.toBase58()) throw new UserError(NO_MARKET);
  const keys = marketKeysFromId(getChain().connection, Uint8Array.from(Buffer.from(record.questionId, "hex")), oracle);
  const same =
    keys.question.toBase58() === record.question &&
    keys.vault.toBase58() === record.vault &&
    keys.pool.toBase58() === record.pool &&
    SIDES.every((side) => keys.mints[side].toBase58() === record.mints[side]);
  if (!same) throw new UserError(NO_MARKET);
  return keys;
}

/** Markets whose question oracle and pool makers checked out. Neither can ever change, so each is read once per process. */
const verifiedQuestions = new Set<string>();
const verifiedMakers = new Set<string>();

/**
 * The oracle made the pool: it holds the position our secret-derived NFT created (provenance.ts).
 * Only checkable until trading closes (closing removes that position); the registry entry was
 * written only after this passed at create, and closed markets take no trades.
 */
async function requireOurPool(keys: MarketKeys): Promise<void> {
  const id = keys.question.toBase58();
  if (verifiedMakers.has(id)) return;
  const owner = await poolOwnership(getChain().connection, keys, positionNftFor(marketSecret(), keys.questionId).publicKey);
  if (owner !== "ours") throw new UserError(NOT_OUR_POOL);
  verifiedMakers.add(id);
}

const NOT_OUR_POOL = "This market's pool wasn't made by memestream, so trading is off for it";

/**
 * The market's pool and question, checked: the pool exactly as we make it (verifyMarketPool), the
 * question resolvable only by our oracle, and while `open`, the pool made by our oracle.
 */
async function loadVerified(keys: MarketKeys, open: boolean): Promise<{ pool: MarketPool; question: QuestionState }> {
  const { connection } = getChain();
  const [pool, question] = await Promise.all([loadMarketPool(connection, keys), fetchQuestion(connection, keys.question)]);
  if (!pool || !question) throw new UserError(NO_MARKET);
  if (!verifiedQuestions.has(keys.question.toBase58())) {
    if (!question.oracle.equals(keys.oracle)) throw new UserError("This market's question isn't memestream's, so trading is off for it");
    verifiedQuestions.add(keys.question.toBase58());
  }
  verifyMarketPool(keys, pool);
  if (open) await requireOurPool(keys);
  return { pool, question };
}

/** Betting is open until the prediction's lockAt and while the question is unresolved; pool liquidity says nothing (anyone can add some). */
const tradingOpen = (record: MarketRecord, question: QuestionState, now: number) => now < record.lockAt && !question.resolved;

/** A Q64.64 little-endian fee-per-liquidity counter from the pool account, as a BN. */
const perLiquidity = (bytes: number[]) => new BN(Buffer.from(bytes).reverse());

/**
 * Shares the pool has swapped out so far (each worth up to 1 SOL): the pool's fees per unit of
 * liquidity, times its liquidity (all the oracle's while trading is open), give the LP's fees; with
 * the protocol's cut added back, that is MARKET_FEE_BPS of every swap's output. The split half of a
 * bet never touches the pool, so this undercounts SOL bet. 0 once trading is closed.
 */
function volumeLamports(pool: MarketPool): BN {
  const { state } = pool;
  const lpFees = state.liquidity.mul(perLiquidity(state.feeAPerLiquidity).add(perLiquidity(state.feeBPerLiquidity))).shrn(LIQUIDITY_SCALE);
  const lpShare = 100 - state.poolFees.protocolFeePercent;
  return lpShare > 0 ? lpFees.muln(100).divn(lpShare).muln(10_000).divn(MARKET_FEE_BPS) : new BN(0);
}

/** Token account amount (u64 @64), or 0 if the account doesn't exist. */
const tokenAmount = (data: Buffer | undefined) => new BN(data && data.length >= 72 ? data.readBigUInt64LE(64).toString() : "0");
const toTokens = (amount: BN) => formatUnits(amount, OUTCOME_DECIMALS);

async function positionOf(keys: MarketKeys, wallet: PublicKey): Promise<MarketPosition> {
  const accounts = [...SIDES.map((side) => getAssociatedTokenAddressSync(keys.mints[side], wallet)), wallet];
  const [yes, no, sol] = await getChain().connection.getMultipleAccountsInfo(accounts);
  return { yes: toTokens(tokenAmount(yes?.data)), no: toTokens(tokenAmount(no?.data)), sol: lamportsToSol(new BN(sol?.lamports ?? 0)) };
}

/** Whether `wallet` holds any YES or NO of a registered market: one read, from the site's RPC budget. */
export async function walletHoldsShares(record: MarketRecord, wallet: string): Promise<boolean> {
  if (!(await takeRpcBudget(1))) throw new BusyError();
  const { yes, no } = await positionOf(keysOf(record), publicKey(wallet, "wallet"));
  return Number(yes) > 0 || Number(no) > 0;
}

/** Odds and state of a registered market: open for bets, closed, or resolved (and how it paid). */
export async function getMarket(record: MarketRecord, wallet: string | null, now: number): Promise<MarketView> {
  return userFacing(async () => {
    const keys = keysOf(record);
    const { pool, question } = await loadVerified(keys, now < record.lockAt);
    return {
      ...marketOdds(pool),
      trading: tradingOpen(record, question, now),
      resolved: question.resolved,
      payoutNumerators: question.resolved ? question.numerators : null,
      lockAt: record.lockAt,
      volumeSol: lamportsToSol(volumeLamports(pool)),
      position: wallet ? await positionOf(keys, publicKey(wallet, "wallet")) : null,
    };
  });
}

export type MarketQuoteRequest = MarketRef & { side: Side; action: "buy" | "sell"; amount: string; slippageBps: number };
/** `minReceived`: the minimum the user saw in the preview, so the bet can't fill worse. */
export type MarketTradeRequest = MarketQuoteRequest & { wallet: string; minReceived?: string };

function orderOf(req: MarketQuoteRequest): MarketOrder {
  return { side: req.side, action: req.action, amount: req.action === "buy" ? solToLamports(req.amount) : parseUnits(req.amount, OUTCOME_DECIMALS) };
}

function previewOf(order: MarketOrder, quote: MarketQuote): MarketPreview {
  const [fmtIn, fmtOut] = order.action === "buy" ? [lamportsToSol, toTokens] : [toTokens, lamportsToSol];
  const before = quote.probabilityBefore;
  // A buy pays more per share than the price before it; a sell gets less.
  const impact = order.action === "buy" ? quote.averagePrice / before - 1 : 1 - quote.averagePrice / before;
  return {
    spent: fmtIn(quote.spentAmount),
    received: fmtOut(quote.outputAmount),
    minimumReceived: fmtOut(quote.minimumAmountOut),
    averagePrice: quote.averagePrice,
    probabilityAfter: quote.probabilityAfter,
    priceImpact: Math.max(0, impact),
  };
}

/** The verified pool of a market that's still taking bets. */
async function openPool(record: MarketRecord, now: number): Promise<{ keys: MarketKeys; pool: MarketPool }> {
  const keys = keysOf(record);
  if (now >= record.lockAt) throw new UserError("Betting on this prediction is closed");
  const { pool, question } = await loadVerified(keys, true);
  if (!tradingOpen(record, question, now)) throw new UserError("Betting on this prediction is closed");
  return { keys, pool };
}

export async function previewMarketTrade(record: MarketRecord, req: MarketQuoteRequest, now: number): Promise<MarketPreview> {
  return userFacing(async () => {
    const order = orderOf(req);
    const { pool } = await openPool(record, now);
    return previewOf(order, quoteMarketTrade(pool, order, req.slippageBps));
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

export async function buildMarketTradeForWallet(record: MarketRecord, req: MarketTradeRequest, now: number): Promise<PreparedTx & { preview: MarketPreview }> {
  return userFacing(async () => {
    const order = orderOf(req);
    const trader = publicKey(req.wallet, "wallet");
    const { keys, pool } = await openPool(record, now);
    const built = await prepareMarketTrade(getChain().connection, keys, pool, trader, order, req.slippageBps, minimumSeen(order, req.minReceived));
    return { ...(await toPreparedTx(built)), preview: previewOf(order, built.quote) };
  });
}

export async function buildMarketRedeemForWallet(record: MarketRecord, wallet: string): Promise<PreparedTx> {
  return userFacing(async () => {
    const keys = keysOf(record);
    await loadVerified(keys, false);
    return toPreparedTx(await buildRedeemTx(getChain().connection, keys, publicKey(wallet, "wallet")));
  });
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

/** A market that can never be ours (someone else made a pool at its address): don't retry, give up. */
export class MarketUnavailableError extends Error {
  override name = "MarketUnavailableError";
}

/** `seedSol`: split into that many YES and NO, all deposited in the pool (it comes back at redemption). */
export type CreateMarketRequest = MarketRef & { ticker: string; seedSol: string };
export type CreatedMarket = { record: Omit<MarketRecord, "lockAt" | "source">; signatures: string[] };

/**
 * Creates and seeds a market, skipping steps already on chain (so a retry finishes a cut-short
 * one), then checks what's on chain is ours before it may be registered: both pools as we make
 * them, holding the oracle's liquidity, and a question only our oracle resolves. YES/NO are named
 * "$TICKER #id YES" where names are on.
 */
export async function createMarket(req: CreateMarketRequest): Promise<CreatedMarket> {
  if (!isPredictionId(req.predictionId)) throw new UserError("Not a valid prediction id");
  const ticker = parseTicker(req.ticker);
  if (!ticker) throw new UserError("Ticker: 1 to 10 letters or digits");
  const { connection } = getChain();
  const keys = marketKeys(connection, marketSecret(), publicKey(req.mint, "coin"), req.predictionId, oraclePublicKey());
  const nft = positionNftFor(marketSecret(), keys.questionId);
  // Never adopt a pool we didn't make (it can look like ours, even name our oracle as its creator).
  if ((await poolOwnership(connection, keys, nft.publicKey)) === "theirs") throw new MarketUnavailableError("Someone else made a pool at this market's address");
  const fresh = !(await fetchQuestion(connection, keys.question));
  const signatures = await sendAllAsOracle(await buildCreateMarketTxs(connection, keys, solToLamports(req.seedSol), nft));
  if (fresh && metadataOn()) {
    // Fits Metaplex's 32-character name: "$" + 10 + " #" + 9 + " YES".
    const names = (side: Side) => ({ name: `$${ticker} #${req.predictionId} ${side.toUpperCase()}`, symbol: side.toUpperCase(), uri: "" });
    await sendAllAsOracle([await buildMarketMetadataTx(connection, keys, { yes: names("yes"), no: names("no") })]).catch((error: Error) =>
      console.warn(`markets: naming the YES/NO mints failed (${error.message}); the market works without names`),
    );
  }
  // Pools that aren't ours (made by someone else, or not as we make them) never will be; a read that
  // found nothing yet is worth a retry.
  await loadVerified(keys, true).catch((error: Error) => {
    const notOurs = (error instanceof UserError || error instanceof InputError) && error.message !== NO_MARKET;
    throw notOurs ? new MarketUnavailableError(error.message) : error;
  });
  const record: CreatedMarket["record"] = {
    mint: req.mint,
    predictionId: req.predictionId,
    oracle: keys.oracle.toBase58(),
    questionId: Buffer.from(keys.questionId).toString("hex"),
    question: keys.question.toBase58(),
    vault: keys.vault.toBase58(),
    mints: { yes: keys.mints.yes.toBase58(), no: keys.mints.no.toBase58() },
    pool: keys.pool.toBase58(),
    signature: signatures.at(-1) ?? "",
  };
  return { record, signatures };
}

/** When betting closes: the oracle takes its liquidity out of both pools. Nothing left to take: no transactions. */
export async function closeMarketTrading(record: MarketRecord): Promise<string[]> {
  const keys = keysOf(record);
  const close = async () => {
    const { pool } = await loadVerified(keys, false);
    return sendAllAsOracle(await buildCloseTradingTxs(getChain().connection, keys, pool, positionNftFor(marketSecret(), keys.questionId).publicKey));
  };
  try {
    return await close();
  } catch (error) {
    // Usually a price pushed past the close's minimums since the quote: quote again at once.
    console.warn(`markets: closing trading failed (${(error as Error).message}); trying again with a fresh quote`);
    return close();
  }
}

/** After the off-chain flow settles: YES, NO, or refund (disputed or cancelled). null if it was already resolved. */
export async function resolveMarket(record: MarketRecord, outcome: Outcome): Promise<string | null> {
  const keys = keysOf(record);
  const question = await fetchQuestion(getChain().connection, keys.question);
  if (question?.resolved) return null;
  const [signature] = await sendAllAsOracle([await buildResolveTx(getChain().connection, keys, outcome)]);
  return signature;
}

/** The oracle redeems the YES/NO its liquidity came back as; null if it holds none (redeemed already). */
export async function redeemOracleTokens(record: MarketRecord): Promise<string | null> {
  let built: BuiltTx;
  try {
    built = await buildRedeemTx(getChain().connection, keysOf(record), oraclePublicKey());
  } catch (error) {
    if (error instanceof InputError && /holds no YES or NO/.test(error.message)) return null;
    throw error;
  }
  const [signature] = await sendAllAsOracle([built]);
  return signature;
}
