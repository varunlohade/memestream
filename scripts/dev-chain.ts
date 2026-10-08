/**
 * LOCAL DEV ONLY: runs an offline Surfpool chain with Meteora's real programs (copied from devnet
 * once, then cached), creates the
 * memestream config, seeds a few stream coins with trades, writes .env.local, and stays up.
 * Run: npm run dev:chain   (then, in another terminal: npm run dev)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair } from "@solana/web3.js";
import { buildCreateConfigTx } from "../src/lib/dbc/config";
import { buildCreateStreamCoinTx } from "../src/lib/dbc/launch";
import { loadPoolSnapshot } from "../src/lib/dbc/pool";
import { COIN_PRESETS } from "../src/lib/dbc/preset";
import { prepareTrade } from "../src/lib/dbc/trade";
import { solToLamports } from "../src/lib/dbc/units";
import { metadataUri, parseStreamLink } from "../src/lib/stream-link";
import { startOfflineSurfnet } from "./local-chain/offline-surfnet";
import { sendAndConfirm } from "./local-chain/send-and-confirm";

const KEYS_DIR = ".keys";
const APP_ORIGIN = "http://127.0.0.1:3000"; // must match how the dev server is opened (npm run dev binds 127.0.0.1)

/** Loads a local test keypair, creating it on first run. Kept in .keys/ (git-ignored). */
function localKeypair(name: string): Keypair {
  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR);
  const path = `${KEYS_DIR}/${name}.json`;
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return keypair;
}

const SAMPLE_STREAMS = [
  // Real public YouTube live streams (checked live and embeddable 2026-10-08). Live IDs change when a stream restarts: re-check with the channel's /live page.
  { name: "lofi beats to study to", symbol: "LOFI", link: "https://www.youtube.com/watch?v=1-LpQekNa9g", buys: ["0.4", "0.3", "0.2"] },
  { name: "synthwave radio", symbol: "SYNTH", link: "https://www.youtube.com/watch?v=4xDzrJKXOOY", buys: ["0.6", "0.5"] },
  { name: "NASA Live", symbol: "NASA", link: "https://www.youtube.com/watch?v=M3HKLzjvKPc", buys: ["0.15"] },
  // Owned by the dev wallet, so the streamer's claim can be clicked through locally.
  { name: "Tokyo night walk", symbol: "DEV", link: "https://www.youtube.com/watch?v=28ZjrtD_iL0", buys: ["0.3"], ownedByDevWallet: true },
] as { name: string; symbol: string; link: string; buys: string[]; ownedByDevWallet?: boolean }[];

async function main() {
  // A stale .env.local would point the app at a dead chain if seeding fails; remove it up front.
  rmSync(".env.local", { force: true });
  const partner = localKeypair("local-partner");
  const devWallet = localKeypair("local-dev-wallet");
  const streamers = SAMPLE_STREAMS.map((s) => (s.ownedByDevWallet ? devWallet : Keypair.generate()));
  const fans = [Keypair.generate(), Keypair.generate()];

  const surfnet = await startOfflineSurfnet([partner, ...new Set([devWallet, ...streamers]), ...fans], {
    solEach: 20,
    realTimeClock: true, // time passes, so the 50% launch fee falls to the base within a minute
  });
  const connection = new Connection(surfnet.rpcUrl, "confirmed");
  const client = new DynamicBondingCurveClient(connection, "confirmed");

  const configTx = await buildCreateConfigTx(client, COIN_PRESETS.devnet, {
    payer: partner.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
  });
  await sendAndConfirm(connection, configTx, [partner]);

  for (const [i, stream] of SAMPLE_STREAMS.entries()) {
    const launch = await buildCreateStreamCoinTx(
      client,
      { name: stream.name, symbol: stream.symbol, uri: (mint) => metadataUri(APP_ORIGIN, mint.toBase58(), parseStreamLink(stream.link)) },
      { config: configTx.config, creator: streamers[i].publicKey },
    );
    await sendAndConfirm(connection, launch, [streamers[i]]);
    const pool = (await client.state.getPoolByBaseMint(launch.mint))?.publicKey;
    if (!pool) throw new Error(`Pool for ${stream.symbol} not found`);
    for (const [j, amount] of stream.buys.entries()) {
      const fan = fans[j % fans.length];
      const trade = await prepareTrade(client, await loadPoolSnapshot(client, pool), fan.publicKey, { side: "buy", lamports: solToLamports(amount) }, 500);
      await sendAndConfirm(connection, trade, [fan]);
    }
    console.log(`seeded $${stream.symbol}  mint ${launch.mint.toBase58()}`);
  }

  // Write to a temp file then rename, so the app never reads a half-written env.
  writeFileSync(
    ".env.local.tmp",
    [
      "# Written by scripts/dev-chain.ts. Local Surfpool fork; regenerated on every run.",
      `MEMESTREAM_RPC_URL=${surfnet.rpcUrl}`,
      `MEMESTREAM_CONFIG=${configTx.config.toBase58()}`,
      `MEMESTREAM_PUBLIC_URL=${APP_ORIGIN}`,
      "MEMESTREAM_NETWORK_LABEL=Local",
      `MEMESTREAM_DEV_WALLET_KEY=${process.cwd()}/${KEYS_DIR}/local-dev-wallet.json`,
      "",
    ].join("\n"),
  );
  renameSync(".env.local.tmp", ".env.local");
  console.log(`\nlocal chain ready at ${surfnet.rpcUrl}`);
  console.log(`config ${configTx.config.toBase58()}`);
  console.log(`dev wallet ${devWallet.publicKey.toBase58()} (20 SOL)`);
  console.log("wrote .env.local. Now run: npm run dev. Ctrl+C here stops the chain.");

  const stop = () => {
    try {
      surfnet.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => surfnet.drainEvents(), 10_000); // keep the event buffer small while idle
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
