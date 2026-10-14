/**
 * Which cluster this deployment runs on, and the settings that must never be wrong on mainnet.
 * MEMESTREAM_WALLET_CHAIN is the one switch: "solana:mainnet" means mainnet. Pure functions
 * over an env object, so next.config.ts (build and start) and the server use the same checks.
 */
type Env = Record<string, string | undefined>;

export const MAINNET_CHAIN = "solana:mainnet";

export const isMainnet = (env: Env = process.env) => env.MEMESTREAM_WALLET_CHAIN === MAINNET_CHAIN;

/** Hostnames of RPC URLs that name mainnet (e.g. mainnet.helius-rpc.com, api.mainnet-beta.solana.com). */
const looksLikeMainnetRpc = (url: string | undefined) => {
  try {
    return /(^|\.)mainnet/.test(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
};

/** Every reason this env is unsafe to run; empty means fine. */
export function deploymentProblems(env: Env = process.env): string[] {
  const problems: string[] = [];
  if (isMainnet(env)) {
    // The localhost test wallet signs with a key the server holds: it must never exist on mainnet.
    if (env.MEMESTREAM_DEV_WALLET_KEY) problems.push("MEMESTREAM_DEV_WALLET_KEY is set on mainnet. Remove it.");
    const url = env.MEMESTREAM_PUBLIC_URL;
    if (url && !/^https:\/\/[^/]+\/?$/.test(url)) problems.push("MEMESTREAM_PUBLIC_URL must be an https:// origin on mainnet (it is baked into every coin).");
  } else if (looksLikeMainnetRpc(env.MEMESTREAM_RPC_URL)) {
    problems.push(`MEMESTREAM_RPC_URL points at mainnet but MEMESTREAM_WALLET_CHAIN is not ${MAINNET_CHAIN}.`);
  }
  return problems;
}

/** Stops the build, the server start, or the first chain access, loudly, if the env is unsafe. */
export function assertSafeDeployment(env: Env = process.env): void {
  const problems = deploymentProblems(env);
  if (problems.length) throw new Error(`Unsafe memestream settings:\n- ${problems.join("\n- ")}`);
}
