/** DEVNET ONLY: a connection that refuses to run against any other cluster. */
import { Connection } from "@solana/web3.js";

const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Connects to public devnet and checks its genesis hash, so a script can never touch mainnet. */
export async function connectToDevnet(): Promise<Connection> {
  const connection = new Connection(DEVNET_RPC, "confirmed");
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH) throw new Error("Not devnet. Stopping.");
  return connection;
}
