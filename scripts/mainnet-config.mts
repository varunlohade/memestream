/**
 * MAINNET: creates memestream's shared DBC config. Its parameters can never change afterwards.
 *
 * Dry run (default): builds the transaction, prints every parameter in plain words, and simulates
 * it. Nothing is signed or sent.
 *   npx tsx scripts/mainnet-config.mts --payer <key file or address>
 * Real run: only with --send AND a typed confirmation, and only on mainnet.
 *   npx tsx scripts/mainnet-config.mts --payer <key file> --send
 *
 * Options: --config-key <path> (default .keys/mainnet-config.json; made on first run, reused after,
 * so the dry run and the send use the same address). RPC: MAINNET_RPC_URL, else Solana's public
 * mainnet RPC. Priority fee cap: MEMESTREAM_PRIORITY_FEE_MAX. Never prints a secret key or the RPC
 * URL (it can hold an API key).
 */
import { Connection } from "@solana/web3.js";
import { describeConfig } from "../src/lib/dbc/config-summary";
import { lamportsToSol } from "../src/lib/dbc/units";
import { pollUntil } from "../src/lib/poll";
import { signatureStatus } from "../src/lib/tx-status";
import BN from "bn.js";
import { readOrCreateKeypair } from "./keys";
import { argValue, clusterName, mainnetRpcUrl, priorityLine, rpcHost, signerFrom, typedConfirmation } from "./mainnet/common";
import { prepareMainnetConfig } from "./mainnet/config-tx";

const DEFAULT_CONFIG_KEY = ".keys/mainnet-config.json";
const argv = process.argv.slice(2);
const send = argv.includes("--send");
const payer = signerFrom(argValue(argv, "--payer"), "--payer");
const configKeyPath = argValue(argv, "--config-key") ?? DEFAULT_CONFIG_KEY;

const rpcUrl = mainnetRpcUrl();
const connection = new Connection(rpcUrl, "confirmed");
const cluster = await clusterName(connection);
const configKey = readOrCreateKeypair(configKeyPath);

console.log(`memestream mainnet config: ${send ? "SEND" : "dry run (nothing is sent)"}`);
console.log(`RPC host: ${rpcHost(rpcUrl)} (cluster: ${cluster})`);
console.log(`Config key file: ${configKeyPath} (git-ignored; keep it until the config exists)`);

if (await connection.getAccountInfo(configKey.publicKey)) {
  console.log(`\nA config already exists at ${configKey.publicKey.toBase58()}. Nothing to do.`);
  console.log(`Set MEMESTREAM_CONFIG=${configKey.publicKey.toBase58()}`);
  process.exit(0);
}

const { built, params, priority, simulation } = await prepareMainnetConfig(connection, payer.publicKey, configKey);

console.log("\nParameters (fixed forever once created):");
const rows = describeConfig(params);
const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, value] of rows) console.log(`  ${label.padEnd(width)}  ${value}`);
console.log(`  ${"Priority fee".padEnd(width)}  ${priorityLine(priority)}`);

console.log("\nSimulation:");
console.log(`  result: ${simulation.ok ? "OK" : `FAILED ${simulation.error}`}`);
console.log(`  compute units used: ${simulation.unitsConsumed ?? "unknown"}`);
if (simulation.payerCostLamports !== null) console.log(`  payer pays about: ${lamportsToSol(new BN(simulation.payerCostLamports))} SOL (rent + fees)`);
if (!simulation.ok) for (const line of simulation.logs.slice(-8)) console.log(`  log: ${line}`);

if (!send) {
  console.log(`\nDry run only. To create it: add --send (needs the payer's key file, on mainnet).`);
  process.exit(simulation.ok ? 0 : 1);
}

// ---- Real send: every guard must pass. ----
if (cluster !== "mainnet") throw new Error("--send works only against mainnet (genesis hash check failed). Stopping.");
if (!payer.keypair) throw new Error("--send needs the payer's key file, not just its address. Stopping.");
if (!simulation.ok) throw new Error("The simulation failed. Fix that first. Stopping.");
const phrase = `create ${configKey.publicKey.toBase58().slice(0, 6)} on mainnet`;
if (!(await typedConfirmation("\nThis creates the mainnet config. Its parameters can never change.", phrase))) {
  console.log("Not confirmed. Nothing sent.");
  process.exit(1);
}
// A fresh blockhash: the old one may have expired while the human typed.
const { blockhash } = await connection.getLatestBlockhash("confirmed");
built.tx.recentBlockhash = blockhash;
built.tx.sign(payer.keypair, ...built.localSigners);
const signature = await connection.sendRawTransaction(built.tx.serialize());
console.log(`Sent: ${signature}`);
const outcome = await pollUntil(async () => {
  const result = await signatureStatus(connection, { signature, blockhash });
  return result.status === "pending" ? undefined : result;
}, { timeoutMs: 90_000, intervalMs: 1_000 });
if (outcome?.status !== "confirmed") throw new Error(`Not confirmed (${outcome?.status ?? "no answer"}). Check ${signature} on Solscan before trying again.`);
console.log(`Confirmed. Config: ${configKey.publicKey.toBase58()}`);
console.log(`Set MEMESTREAM_CONFIG=${configKey.publicKey.toBase58()} in the mainnet Vercel env, and record it in MAINNET-CHECKLIST.md.`);
