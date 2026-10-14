/** DEVNET ONLY: tops up the two demo wallets from .keys/partner.json. */
import { type Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { connectToDevnet } from "../scripts/devnet";
import { readKeypair } from "../scripts/keys";
const c = await connectToDevnet();
const partner = readKeypair(".keys/partner.json");
async function fund(to: Keypair, sol: number) {
  const have = await c.getBalance(to.publicKey);
  const want = Math.round(sol * LAMPORTS_PER_SOL);
  if (have >= want) return console.log("ok", to.publicKey.toBase58());
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: partner.publicKey, toPubkey: to.publicKey, lamports: want - have }));
  const sig = await c.sendTransaction(tx, [partner]);
  await c.confirmTransaction(sig, "confirmed");
  console.log("funded", to.publicKey.toBase58(), sig);
}
await fund(readKeypair(".keys/devnet-creator.json"), 0.12);
await fund(readKeypair(".keys/devnet-viewer.json"), 0.45);
