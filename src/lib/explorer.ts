/** Solscan links for the app's cluster (a Wallet Standard id such as "solana:devnet"). */
const clusterQuery = (chain: string) => (chain === "solana:mainnet" ? "" : `?cluster=${chain.replace("solana:", "")}`);

export const solscanTx = (signature: string, chain: string) => `https://solscan.io/tx/${signature}${clusterQuery(chain)}`;
export const solscanAccount = (address: string, chain: string) => `https://solscan.io/account/${address}${clusterQuery(chain)}`;
