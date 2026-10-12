/**
 * Shapes the API returns, shared by server routes and client components.
 * No runtime dependencies, so client code can import it freely.
 */

/**
 * - trading: the curve is open.
 * - graduating: the curve holds the threshold; waiting for migration to DAMM v2.
 * - graduated: liquidity moved to DAMM v2; trade there, not here.
 */
export type CoinStatus = "trading" | "graduating" | "graduated";

export type CoinView = {
  pool: string;
  mint: string;
  creator: string;
  status: CoinStatus;
  /** 0 to 1. */
  progress: number;
  priceSol: number;
  marketCapSol: number;
  raisedSol: string;
  thresholdSol: string;
  /** Streamer's earned SOL not yet claimed. */
  streamerUnclaimedSol: string;
  /** When trading opened (unix seconds). */
  launchedAt: number;
  name: string;
  symbol: string;
  /** Normalised Twitch/YouTube/Kick link, if the streamer gave one. */
  streamUrl: string | null;
  /** The Meteora DAMM v2 pool a graduated coin trades in (null before graduation). */
  meteoraPool: string | null;
};

export type TradeView = {
  signature: string;
  side: "buy" | "sell";
  sol: string;
  coins: string;
  wallet: string;
  /** Unix seconds. */
  time: number | null;
  /** SOL per coin for this trade, for the chart. */
  priceSol: number;
  byStreamer: boolean;
};

export type Holdings = {
  sol: string;
  coins: string;
  /** Unclaimed fees on the LP position NFTs this wallet holds in a graduated coin's pool (null: none). */
  lpFees: { sol: string; coins: string } | null;
};

export type CoinDetail = { coin: CoinView; trades: TradeView[]; holdings: Holdings | null };

export type TradePreview = { spent: string; received: string; minimumReceived: string; partial: boolean };

/**
 * A transaction for the wallet: base64 bytes, already partial-signed by any server-made keypairs.
 * `blockhash` is the one the server built it with; once it's invalid the tx can never land.
 */
export type PreparedTx = { transaction: string; blockhash: string };

export type TxAction = "launch" | "trade" | "claim" | "graduate" | "claim-lp";

/** expired = the server's blockhash ran out with the signature unseen; the user must check their wallet. */
export type TxStatus = { status: "pending" | "confirmed" | "failed" | "expired"; error?: string };

/** One slippage setting for quotes and trades: 1%. */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** The only max-slippage values a user can pick (0.5%, 1%, 3%, 5%); the server ignores anything else. */
export const SLIPPAGE_CHOICES_BPS = [50, 100, 300, 500] as const;

/** Token decimals for browser code; lib/dbc/units.ts uses the same values (units.test.ts pins them). */
export const SOL_DECIMALS = 9;
export const COIN_DECIMALS = 6;

/** One item on the site's ticker tape (design B: live trades, with graduation-race filler). */
export type TapeItem =
  | { kind: "trade"; mint: string; symbol: string; side: "buy" | "sell"; sol: string; wallet: string; time: number | null }
  | { kind: "graduated"; mint: string; symbol: string }
  | { kind: "race"; mint: string; symbol: string; progress: number };

/**
 * One holder of a coin: an owner wallet (or program authority), its share of total supply in
 * percent, and its role: the bonding curve's vault, the Meteora pool's vault, or the streamer.
 */
export type HolderView = { owner: string; percent: number; role: "curve" | "pool" | "streamer" | null };
