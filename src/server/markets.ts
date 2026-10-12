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
 * addresses; MEMESTREAM_MARKET_METADATA=1/0 names the YES/NO mints (default: on except mainnet).
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { getAmountBFromLiquidityDeltaForConcentratedLiquidity, getSqrtPriceFromPrice, Rounding } from "@meteora-ag/cp-amm-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { PreparedTx, TradePreview } from "@/lib/api-types";
import type { DammQuote } from "@/lib/damm/trade";
import { lpPositionsOf } from "@/lib/damm/positions";
import { formatUnits, lamportsToSol, parseUnits, solToLamports } from "@/lib/dbc/units";
import type { BuiltTx } from "@/lib/dbc/tx";
import { buildCreateMarketTxs, buildMarketMetadataTx } from "@/lib/markets/create";
import { isPredictionId, MIN_MARKET_SECRET_CHARS, type Outcome, type Side } from "@/lib/markets/math";
import {
  loadMarketPools,
  MARKET_FEE_BPS,
  type MarketKeys,
  marketKeys,
  marketKeysFromId,
  marketOdds,
  type MarketPools,
  OUTCOME_DECIMALS,
  verifyMarketPools,
} from "@/lib/markets/pool";
import type { MarketPosition, MarketRecord, MarketView } from "@/lib/markets/record";
import { buildCloseTradingTxs, buildRedeemTx, buildResolveTx } from "@/lib/markets/settle";
import { type MarketOrder, prepareMarketTrade, quoteMarketTrade } from "@/lib/markets/trade";
import { fetchQuestion, type QuestionState } from "@/lib/markets/vault";
import { pollUntil } from "@/lib/poll";
import { parseTicker } from "@/lib/short-link";
import { getChain, networkInfo, rememberBuilt, signatureStatus } from "./chain";
import { asUserFacing, UserError } from "./errors";

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

/** Names on the YES/NO mints: MetaDAO lets only its deployer add them on mainnet, so they're off there unless set. */
function metadataOn(): boolean {
  const set = process.env.MEMESTREAM_MARKET_METADATA;
  if (set === "1" || set === "0") return set === "1";
  return networkInfo().walletChain !== "solana:mainnet";
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
    SIDES.every((side) => keys.mints[side].toBase58() === record.mints[side] && keys.pools[side].toBase58() === record.pools[side]);
  if (!same) throw new UserError(NO_MARKET);
  return keys;
}

/** Questions whose oracle checked out: that never changes, so it's read once per process. */
const verifiedQuestions = new Set<string>();

/**
 * The market's pools and question, checked: both pools exactly as we make them (verifyMarketPools)
 * and the question resolvable only by our oracle.
 */
async function loadVerified(keys: MarketKeys): Promise<{ pools: MarketPools; question: QuestionState }> {
  const { connection } = getChain();
  const [pools, question] = await Promise.all([loadMarketPools(connection, keys), fetchQuestion(connection, keys.question)]);
  if (!pools || !question) throw new UserError(NO_MARKET);
  if (!verifiedQuestions.has(keys.question.toBase58())) {
    if (!question.oracle.equals(keys.oracle)) throw new UserError("This market's question isn't memestream's, so trading is off for it");
    verifiedQuestions.add(keys.question.toBase58());
  }
  verifyMarketPools(keys, pools);
  return { pools, question };
}

/** Betting is open until the prediction's lockAt and while the question is unresolved; pool liquidity says nothing (anyone can add some). */
const tradingOpen = (record: MarketRecord, question: QuestionState, now: number) => now < record.lockAt && !question.resolved;

/** A side's price that a buy may take it to at most: past it, the pool's stock is nearly gone. */
const MAX_BUY_PRICE = "0.99";
/** Kept off the most a buy can take, for rounding and price moves before it lands. */
const MAX_BUY_MARGIN_BPS = 200;

/** The most SOL a buy of `side` can spend now, fee included (0 when the side is at the top). */
function maxBuyLamports(pools: MarketPools, side: Side): BN {
  const { state } = pools[side];
  const target = getSqrtPriceFromPrice(MAX_BUY_PRICE, OUTCOME_DECIMALS, OUTCOME_DECIMALS);
  if (state.sqrtPrice.gte(target)) return new BN(0);
  const net = getAmountBFromLiquidityDeltaForConcentratedLiquidity(state.sqrtPrice, target, state.liquidity, Rounding.Down);
  return net.muln(10_000).divn(10_000 - MARKET_FEE_BPS).muln(10_000 - MAX_BUY_MARGIN_BPS).divn(10_000);
}

/** SOL traded in both pools so far: the 1% fee is taken in SOL on every trade, so fees / 1%. */
function volumeLamports(pools: MarketPools): BN {
  return SIDES.map((side) => pools[side].state.metrics)
    .map((m) => m.totalLpBFee.add(m.totalProtocolBFee))
    .reduce((a, b) => a.add(b), new BN(0))
    .muln(10_000)
    .divn(MARKET_FEE_BPS);
}

/** Token account amount (u64 @64), or 0 if the account doesn't exist. */
const tokenAmount = (data: Buffer | undefined) => new BN(data && data.length >= 72 ? data.readBigUInt64LE(64).toString() : "0");
const toTokens = (amount: BN) => formatUnits(amount, OUTCOME_DECIMALS);

async function positionOf(keys: MarketKeys, wallet: PublicKey): Promise<MarketPosition> {
  const accounts = [...SIDES.map((side) => getAssociatedTokenAddressSync(keys.mints[side], wallet)), wallet];
  const [yes, no, sol] = await getChain().connection.getMultipleAccountsInfo(accounts);
  return { yes: toTokens(tokenAmount(yes?.data)), no: toTokens(tokenAmount(no?.data)), sol: lamportsToSol(new BN(sol?.lamports ?? 0)) };
}

/** Odds and state of a registered market: open for bets, closed, or resolved (and how it paid). */
export async function getMarket(record: MarketRecord, wallet: string | null, now: number): Promise<MarketView> {
  return userFacing(async () => {
    const keys = keysOf(record);
    const { pools, question } = await loadVerified(keys);
    return {
      ...marketOdds(pools),
      trading: tradingOpen(record, question, now),
      resolved: question.resolved,
      payoutNumerators: question.resolved ? question.numerators : null,
      lockAt: record.lockAt,
      volumeSol: lamportsToSol(volumeLamports(pools)),
      maxBuySol: { yes: lamportsToSol(maxBuyLamports(pools, "yes")), no: lamportsToSol(maxBuyLamports(pools, "no")) },
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

function previewOf(order: MarketOrder, quote: DammQuote): TradePreview {
  const [fmtIn, fmtOut] = order.action === "buy" ? [lamportsToSol, toTokens] : [toTokens, lamportsToSol];
  return { spent: fmtIn(quote.spentAmount), received: fmtOut(quote.outputAmount), minimumReceived: fmtOut(quote.minimumAmountOut), partial: false };
}

/** The verified pools of a market that's still taking bets. */
async function openPools(record: MarketRecord, now: number): Promise<{ keys: MarketKeys; pools: MarketPools }> {
  const keys = keysOf(record);
  const { pools, question } = await loadVerified(keys);
  if (!tradingOpen(record, question, now)) throw new UserError("Betting on this prediction is closed");
  return { keys, pools };
}

export async function previewMarketTrade(record: MarketRecord, req: MarketQuoteRequest, now: number): Promise<TradePreview> {
  return userFacing(async () => {
    const order = orderOf(req);
    const { pools } = await openPools(record, now);
    return previewOf(order, await quoteMarketTrade(pools, order, req.slippageBps));
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

export async function buildMarketTradeForWallet(record: MarketRecord, req: MarketTradeRequest, now: number): Promise<PreparedTx & { preview: TradePreview }> {
  return userFacing(async () => {
    const order = orderOf(req);
    const trader = publicKey(req.wallet, "wallet");
    const { pools } = await openPools(record, now);
    const built = await prepareMarketTrade(getChain().connection, pools, trader, order, req.slippageBps, minimumSeen(order, req.minReceived));
    return { ...(await toPreparedTx(built)), preview: previewOf(order, built.quote) };
  });
}

export async function buildMarketRedeemForWallet(record: MarketRecord, wallet: string): Promise<PreparedTx> {
  return userFacing(async () => {
    const keys = keysOf(record);
    await loadVerified(keys);
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

export type CreateMarketRequest = MarketRef & { ticker: string; seedSolPerPool: string };
export type CreatedMarket = { record: Omit<MarketRecord, "lockAt">; signatures: string[] };

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
  const fresh = !(await fetchQuestion(connection, keys.question));
  const signatures = await sendAllAsOracle(await buildCreateMarketTxs(connection, keys, solToLamports(req.seedSolPerPool)));
  if (fresh && metadataOn()) {
    // Fits Metaplex's 32-character name: "$" + 10 + " #" + 9 + " YES".
    const names = (side: Side) => ({ name: `$${ticker} #${req.predictionId} ${side.toUpperCase()}`, symbol: side.toUpperCase(), uri: "" });
    await sendAllAsOracle([await buildMarketMetadataTx(connection, keys, { yes: names("yes"), no: names("no") })]).catch((error: Error) =>
      console.warn(`markets: naming the YES/NO mints failed (${error.message}); the market works without names`),
    );
  }
  const { pools } = await loadVerified(keys);
  for (const side of SIDES) {
    if ((await lpPositionsOf(connection, pools[side].address, keys.oracle)).length === 0) throw new Error(`markets: the oracle holds no liquidity in the ${side} pool`);
  }
  const record: CreatedMarket["record"] = {
    mint: req.mint,
    predictionId: req.predictionId,
    oracle: keys.oracle.toBase58(),
    questionId: Buffer.from(keys.questionId).toString("hex"),
    question: keys.question.toBase58(),
    vault: keys.vault.toBase58(),
    mints: { yes: keys.mints.yes.toBase58(), no: keys.mints.no.toBase58() },
    pools: { yes: keys.pools.yes.toBase58(), no: keys.pools.no.toBase58() },
    signature: signatures.at(-1) ?? "",
  };
  return { record, signatures };
}

/** When betting closes: the oracle takes its liquidity out of both pools. Nothing left to take: no transactions. */
export async function closeMarketTrading(record: MarketRecord): Promise<string[]> {
  const keys = keysOf(record);
  const { pools } = await loadVerified(keys);
  return sendAllAsOracle(await buildCloseTradingTxs(getChain().connection, keys, pools));
}

/** After the off-chain flow settles: YES, NO, or refund (disputed or cancelled). null if it was already resolved. */
export async function resolveMarket(record: MarketRecord, outcome: Outcome): Promise<string | null> {
  const keys = keysOf(record);
  const question = await fetchQuestion(getChain().connection, keys.question);
  if (question?.resolved) return null;
  const [signature] = await sendAllAsOracle([await buildResolveTx(getChain().connection, keys, outcome)]);
  return signature;
}

/** The oracle redeems the YES/NO its liquidity came back as. */
export async function redeemOracleTokens(record: MarketRecord): Promise<string> {
  const [signature] = await sendAllAsOracle([await buildRedeemTx(getChain().connection, keysOf(record), oraclePublicKey())]);
  return signature;
}
