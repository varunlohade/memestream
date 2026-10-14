import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { connectToDevnet } from "/Users/varun/chat-coins/scripts/devnet";
import { readKeypair } from "/Users/varun/chat-coins/scripts/keys";
const c = await connectToDevnet();
for (const n of ["partner","devnet-creator","devnet-viewer"]) {
  const k = readKeypair(`/Users/varun/chat-coins/.keys/${n}.json`);
  console.log(n, k.publicKey.toBase58(), (await c.getBalance(k.publicKey))/LAMPORTS_PER_SOL);
}
