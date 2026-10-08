/**
 * DEVNET ONLY: one full coin life on real devnet, through the LIVE site's API (not Surfpool):
 * launch (creator), buy + sell (viewer), fill to the threshold, graduate to DAMM v2, claim.
 * Two throwaway keypairs in .keys/ (git-ignored) are funded from .keys/partner.json.
 * Run:  npx tsx scripts/devnet-pass.mts [https://memestream-iota.vercel.app]
 */
import { type Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { sleep } from "../src/lib/poll";
import { connectToDevnet } from "./devnet";
import { readKeypair, readOrCreateKeypair } from "./keys";

const SITE = process.argv[2] ?? "https://memestream-iota.vercel.app";
const connection = await connectToDevnet();

const partner = readKeypair(".keys/partner.json");
const creator = readOrCreateKeypair(".keys/devnet-creator.json");
const viewer = readOrCreateKeypair(".keys/devnet-viewer.json");
const signatures: [string, string][] = [];

async function fund(to: Keypair, sol: number) {
  const have = await connection.getBalance(to.publicKey);
  const want = Math.round(sol * LAMPORTS_PER_SOL);
  if (have >= want) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: partner.publicKey, toPubkey: to.publicKey, lamports: want - have }));
  const sig = await connection.sendTransaction(tx, [partner]);
  await connection.confirmTransaction(sig, "confirmed");
  signatures.push([`fund ${to.publicKey.toBase58().slice(0, 6)}`, sig]);
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SITE}${path}`, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error ?? ""}`);
  return json;
}

/** Ask the live site to build, sign locally, send to devnet, and wait on the site's own status route. */
async function run(step: string, action: string, wallet: Keypair, body: Record<string, unknown>) {
  const prepared = await api<{ transaction: string; blockhash: string; mint?: string }>(`/api/tx/${action}`, { wallet: wallet.publicKey.toBase58(), ...body });
  const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  tx.partialSign(wallet);
  const sig = await connection.sendRawTransaction(tx.serialize());
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const s = await api<{ status: string; error?: string }>(`/api/tx/status?signature=${sig}&blockhash=${prepared.blockhash}`);
    if (s.status === "confirmed") {
      signatures.push([step, sig]);
      console.log(`OK    ${step}  ${sig}`);
      return prepared;
    }
    if (s.status !== "pending") throw new Error(`${step}: ${s.status} ${s.error ?? ""} ${sig}`);
  }
  throw new Error(`${step}: no answer in 2 min ${sig}`);
}

type Detail = { coin: { status: string; progress: number; streamerUnclaimedSol: string }; holdings: { coins: string } | null };
const detail = (mint: string, wallet?: Keypair) => api<Detail>(`/api/coins/${mint}${wallet ? `?wallet=${wallet.publicKey.toBase58()}` : ""}`);
async function waitFor(mint: string, what: string, ok: (d: Detail) => boolean, wallet?: Keypair) {
  for (let i = 0; i < 30; i++) {
    const d = await detail(mint, wallet);
    if (ok(d)) return d;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

await fund(creator, 0.1);
await fund(viewer, 0.4);

const symbol = `DV${Date.now().toString(36).slice(-6).toUpperCase()}`;
const launch = await run("launch", "launch", creator, {
  name: "devnet pass",
  symbol,
  streamUrl: "https://www.youtube.com/watch?v=4xDzrJKXOOY",
});
const mint = launch.mint as string;
console.log(`coin  $${symbol}  ${SITE}/coin/${mint}`);
await waitFor(mint, "coin visible on the site", () => true);

console.log("waiting 65 s for the launch fee to fall to the base");
await sleep(65_000);

await run("buy 0.02 SOL", "trade", viewer, { mint, side: "buy", amount: "0.02" });
const held = await waitFor(mint, "viewer holds coins", (d) => Number(d.holdings?.coins ?? 0) > 0, viewer);
const half = (Number(held.holdings?.coins) / 2).toFixed(6);
await run(`sell ${half} coins`, "trade", viewer, { mint, side: "sell", amount: half });
await run("buy 0.2 SOL (fills the curve)", "trade", viewer, { mint, side: "buy", amount: "0.2" });
await waitFor(mint, "curve full", (d) => d.coin.status === "graduating");
await run("graduate to DAMM v2", "graduate", viewer, { mint });
await waitFor(mint, "graduated", (d) => d.coin.status === "graduated");
await waitFor(mint, "fees to claim", (d) => Number(d.coin.streamerUnclaimedSol) > 0);
await run("creator claims fees", "claim", creator, { mint });
await waitFor(mint, "fees claimed", (d) => Number(d.coin.streamerUnclaimedSol) === 0);

console.log("\nALL STEPS CONFIRMED");
for (const [step, sig] of signatures) console.log(`${step.padEnd(32)} https://explorer.solana.com/tx/${sig}?cluster=devnet`);
