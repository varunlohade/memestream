/**
 * `npm run e2e:predictions:local`: builds the app into .next-e2e, starts `next start` on a free port
 * with a production-like devnet setup and a fresh Redis key prefix (memestream:pm-e2e:<run id>:),
 * runs scripts/predictions-e2e.mts against it, then stops the server.
 *
 * Needs the Upstash URL and token: from the environment (UPSTASH_REDIS_REST_* or KV_REST_API_*), or
 * from the git-ignored .env.e2e.local, made with:
 *   vercel env pull .env.e2e.local --environment=development
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { sleep } from "../src/lib/poll";
import { readOrCreateKeypair } from "./keys";

const ENV_FILE = ".env.e2e.local";
const REDIS_VARS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
const START_TIMEOUT_MS = 60_000;

/** Only the Redis variables from the env file, and only where the environment doesn't set them. Values are never printed. */
function redisEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REDIS_VARS) if (process.env[name]) out[name] = process.env[name]!;
  if (!existsSync(ENV_FILE)) return out;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match || !REDIS_VARS.includes(match[1]) || out[match[1]]) continue;
    out[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

function exitCode(child: ChildProcess) {
  return new Promise<number>((resolve) => child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))));
}

if (process.env.VERCEL_ENV === "production") throw new Error("Not on production (VERCEL_ENV=production)");
const redis = redisEnv();
if (!((redis.UPSTASH_REDIS_REST_URL && redis.UPSTASH_REDIS_REST_TOKEN) || (redis.KV_REST_API_URL && redis.KV_REST_API_TOKEN))) {
  console.error(`No Upstash Redis URL and token. Run: vercel env pull ${ENV_FILE} --environment=development (see TESTING-devnet.md)`);
  process.exit(1);
}

// Typed questions go through jev review, so the run needs the real key (server-side only; never printed).
if (!process.env.TYPESAFE_API_KEY) {
  console.error("No TYPESAFE_API_KEY. Load it into this shell first: set -a; . ~/instinct-lite/.env; set +a");
  process.exit(1);
}

const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const port = await freePort();
const baseUrl = `http://localhost:${port}`;
const prefix = `memestream:pm-e2e:${runId}:`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...redis,
  NEXT_DIST_DIR: ".next-e2e",
  MEMESTREAM_RPC_URL: process.env.MEMESTREAM_RPC_URL || "https://api.devnet.solana.com",
  MEMESTREAM_CONFIG: "Buiw2JGkLJKgUcYPhsJ64L8x6xANqzHFxxnuc31mWyVg",
  MEMESTREAM_WALLET_CHAIN: "solana:devnet",
  MEMESTREAM_NETWORK_LABEL: "Devnet",
  MEMESTREAM_PUBLIC_URL: baseUrl,
  MEMESTREAM_PREDICTIONS: "1",
  MEMESTREAM_PREDICTIONS_SECRET: randomBytes(32).toString("hex"),
  MEMESTREAM_PREDICTIONS_PREFIX: prefix,
  // The admin wallet predictions-e2e.mts cancels with (public key only).
  MEMESTREAM_ADMIN_WALLETS: readOrCreateKeypair(".keys/e2e-admin.json").publicKey.toBase58(),
  // No AI referee: the streamer decides every result at the lock, so the run is quick and exact.
  OPENROUTER_API_KEY: "",
};

console.log(`run ${runId}: building into .next-e2e`);
const build = spawn("npx", ["next", "build"], { env, stdio: ["ignore", "ignore", "inherit"] });
if ((await exitCode(build)) !== 0) {
  console.error("FAIL build");
  process.exit(1);
}

console.log(`run ${runId}: starting next on ${baseUrl}`);
const server = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(port)], { env, stdio: ["ignore", "ignore", "inherit"], detached: true });
const stopServer = () => {
  try {
    process.kill(-server.pid!, "SIGTERM"); // the whole group: npx and next
  } catch {
    // already stopped
  }
};
process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});

let code = 1;
try {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let up = false;
  while (!up && Date.now() < deadline) {
    up = await fetch(baseUrl).then(
      () => true,
      () => false,
    );
    if (!up) await sleep(500);
  }
  if (!up) throw new Error(`next start didn't answer in ${START_TIMEOUT_MS / 1000} s`);
  const test = spawn("npx", ["tsx", "scripts/predictions-e2e.mts"], { env: { ...env, BASE_URL: baseUrl }, stdio: "inherit" });
  code = await exitCode(test);
} catch (error) {
  console.error(`FAIL ${(error as Error).message}`);
} finally {
  stopServer();
}
process.exit(code);
