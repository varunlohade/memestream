/**
 * Claims memestream's partner fees on a config: its share of curve trading fees and the launch fee
 * of every coin. The config's fee claimer signs and pays (on mainnet: the owner's wallet).
 *
 * Dry run (default): lists what's claimable, builds the batched claim transactions and simulates
 * each one. Nothing is signed or sent.
 *   npx tsx scripts/claim-partner-fees.mts --config <address> [--claimer <key file or address>]
 * Real run: --send with the fee claimer's key file, then a typed confirmation.
 *   npx tsx scripts/claim-partner-fees.mts --config <address> --claimer <key file> --send
 * If the claimer is a browser wallet (no key file), use the admin page instead: /admin/fees.
 *
 * RPC: MAINNET_RPC_URL, else Solana's public mainnet RPC. RPC_URL overrides it for other clusters
 * (e.g. a local fork). Never prints a secret key or the RPC URL.
 */
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { buildPartnerClaimTxs, loadPartnerFees } from "../src/lib/dbc/partner-fees";
import { lamportsToSol } from "../src/lib/dbc/units";
import { pollUntil } from "../src/lib/poll";
import { signatureStatus } from "../src/lib/tx-status";
import { argValue, clusterName, mainnetRpcUrl, prepareAndSimulate, priorityLine, rpcHost, signerFrom, typedConfirmation } from "./mainnet/common";

const argv = process.argv.slice(2);
const send = argv.includes("--send");
const configArg = argValue(argv, "--config") ?? process.env.MEMESTREAM_CONFIG;
if (!configArg) throw new Error("Give --config <address> (or set MEMESTREAM_CONFIG)");
const config = new PublicKey(configArg);

const rpcUrl = process.env.RPC_URL || mainnetRpcUrl();
const connection = new Connection(rpcUrl, "confirmed");
const client = new DynamicBondingCurveClient(connection, "confirmed");
const cluster = await clusterName(connection);
console.log(`memestream partner fees: ${send ? "SEND" : "dry run (nothing is sent)"}`);
console.log(`RPC host: ${rpcHost(rpcUrl)} (cluster: ${cluster}); config ${config.toBase58()}`);

const fees = await loadPartnerFees(client, config);
const claimer = signerFrom(argValue(argv, "--claimer") ?? fees.feeClaimer.toBase58(), "--claimer");
console.log(`Fee claimer: ${fees.feeClaimer.toBase58()}. Coins on the config: ${fees.poolCount}. With fees to claim: ${fees.pools.length}.`);
for (const p of fees.pools) {
  console.log(`  ${p.baseMint.toBase58()}  trading ${lamportsToSol(p.tradingLamports)} SOL, launch fee ${lamportsToSol(p.launchFeeLamports)} SOL`);
}
console.log(`Total: ${lamportsToSol(fees.totalLamports)} SOL`);
if (fees.pools.length === 0) process.exit(0);

const txs = await buildPartnerClaimTxs(client, fees, claimer.publicKey);
const prepared = [];
for (const [i, built] of txs.entries()) {
  const { priority, simulation } = await prepareAndSimulate(connection, built.tx);
  const gain = simulation.payerCostLamports === null ? "?" : lamportsToSol(new BN(-simulation.payerCostLamports));
  console.log(`Transaction ${i + 1}/${txs.length}: ${built.tx.instructions.length} instructions; simulation ${simulation.ok ? "OK" : `FAILED ${simulation.error}`}; claimer gains ${gain} SOL net`);
  console.log(`  priority fee: ${priorityLine(priority)}`);
  if (!simulation.ok) for (const line of simulation.logs.slice(-6)) console.log(`  log: ${line}`);
  prepared.push({ built, ok: simulation.ok });
}

if (!send) {
  console.log("\nDry run only. To claim: add --send with the fee claimer's key file, or use /admin/fees in the browser.");
  process.exit(prepared.every((p) => p.ok) ? 0 : 1);
}

if (!claimer.keypair) throw new Error("--send needs the fee claimer's key file. Stopping.");
if (prepared.some((p) => !p.ok)) throw new Error("A simulation failed. Stopping.");
const phrase = `claim ${lamportsToSol(fees.totalLamports)} SOL`;
if (!(await typedConfirmation(`\nThis sends ${prepared.length} claim transaction(s) on ${cluster}.`, phrase))) {
  console.log("Not confirmed. Nothing sent.");
  process.exit(1);
}
for (const { built } of prepared) {
  // A fresh blockhash: the old one may have expired while the human typed.
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  built.tx.recentBlockhash = blockhash;
  built.tx.sign(claimer.keypair);
  const signature = await connection.sendRawTransaction(built.tx.serialize());
  const outcome = await pollUntil(async () => {
    const result = await signatureStatus(connection, { signature, blockhash });
    return result.status === "pending" ? undefined : result;
  }, { timeoutMs: 90_000, intervalMs: 1_000 });
  console.log(`${signature}: ${outcome?.status ?? "no answer (check Solscan)"}`);
  if (outcome?.status !== "confirmed") process.exit(1);
}
