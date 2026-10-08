/**
 * Shapes the API returns, shared by server routes and client components.
 * No runtime dependencies, so client code can import it freely.
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

export type Holdings = { sol: string; coins: string };

export type CoinDetail = { coin: CoinView; trades: TradeView[]; holdings: Holdings | null };

export type TradePreview = { spent: string; received: string; minimumReceived: string; partial: boolean };

/**
 * A transaction for the wallet: base64 bytes, already partial-signed by any server-made keypairs.
 * `blockhash` is the one the server built it with; once it's invalid the tx can never land.
 */
export type PreparedTx = { transaction: string; blockhash: string };

export type TxAction = "launch" | "trade" | "claim" | "graduate";

/** expired = the server's blockhash ran out with the signature unseen; the user must check their wallet. */
export type TxStatus = { status: "pending" | "confirmed" | "failed" | "expired"; error?: string };

/** One slippage setting for quotes and trades: 1%. */
export const DEFAULT_SLIPPAGE_BPS = 100;

export const SOL_DECIMALS = 9;
export const COIN_DECIMALS = 6;
