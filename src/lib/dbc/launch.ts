/** Per-stream action: a streamer launches a coin on the shared memestream config. */
import type { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { InputError } from "./errors";
import { type BuiltTx, built } from "./tx";

/** Metaplex metadata limits, in UTF-8 bytes (emoji count as several). */
const MAX_NAME_BYTES = 32;
const MAX_SYMBOL_BYTES = 10;
const MAX_URI_BYTES = 200;

export type StreamCoin = {
  /** Shown as the token name, e.g. the stream title. */
  name: string;
  /** Ticker, e.g. "HYPE". */
  symbol: string;
  /** JSON metadata URL (image, stream link). */
  uri: string;
};

/** The metadata URI, given directly or built from the new coin's mint address. */
export type CoinRequest = Omit<StreamCoin, "uri"> & { uri: string | ((mint: PublicKey) => string) };

export type StreamCoinAccounts = {
  config: PublicKey;
  /** The streamer. As pool creator, this wallet receives the creator fee share. */
  creator: PublicKey;
  /** Pays rent and fees. Defaults to the creator; the platform can sponsor launches. */
  payer?: PublicKey;
};

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function requireField(label: string, value: string, maxBytes: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new InputError(`${label} is required`);
  if (byteLength(trimmed) > maxBytes) {
    throw new InputError(`${label} must be at most ${maxBytes} bytes (emoji count as several)`);
  }
  return trimmed;
}

/** Trims and checks a coin; the result is exactly what goes on-chain. Safe to use for form errors. */
export function parseStreamCoin(coin: StreamCoin): StreamCoin {
  return {
    name: requireField("Name", coin.name, MAX_NAME_BYTES),
    symbol: requireField("Symbol", coin.symbol, MAX_SYMBOL_BYTES),
    uri: requireField("Metadata URI", coin.uri, MAX_URI_BYTES),
  };
}

/**
 * Launches a coin at a fresh mint address; the mint keypair is in `localSigners`.
 * The creator must also sign if it isn't the fee payer.
 */
export async function buildCreateStreamCoinTx(
  client: DynamicBondingCurveClient,
  coin: CoinRequest,
  accounts: StreamCoinAccounts,
): Promise<BuiltTx & { mint: PublicKey }> {
  const mint = Keypair.generate();
  const payer = accounts.payer ?? accounts.creator;
  const uri = typeof coin.uri === "function" ? coin.uri(mint.publicKey) : coin.uri;
  const tx = await client.creator.createPool({
    ...parseStreamCoin({ ...coin, uri }),
    config: accounts.config,
    baseMint: mint.publicKey,
    poolCreator: accounts.creator,
    payer,
  });
  return { ...built(tx, payer, [mint]), mint: mint.publicKey };
}
