/**
 * LOCAL DEV AND TESTS ONLY. An offline Surfpool chain with the devnet programs and accounts
 * memestream needs copied in. They're fetched from devnet once into .cache/devnet/, checked,
 * and reused, so runs never touch the network (no rate limits, no hangs).
 *
 * The cache rebuilds by itself when the SDK version or source RPC changes, or a file fails its
 * checksum. Force a refresh (e.g. after Meteora upgrades a program) with SNAPSHOT_REFRESH=1.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDammV2PoolAuthority,
  deriveDbcPoolAuthority,
  METAPLEX_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CONDITIONAL_VAULT_PROGRAM_ID } from "@metadaoproject/futarchy/v0.4";
import { Surfnet } from "@solana/surfpool";
import { Connection, type Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE_DIR = join(REPO_ROOT, ".cache/devnet");
const MANIFEST = join(CACHE_DIR, "manifest.json");
const SOURCE_RPC = process.env.SNAPSHOT_SOURCE_RPC ?? "https://api.devnet.solana.com";
/** The SDK doesn't export its package.json, so read it from node_modules. */
const SDK_VERSION: string = JSON.parse(
  readFileSync(join(REPO_ROOT, "node_modules/@meteora-ag/dynamic-bonding-curve-sdk/package.json"), "utf8"),
).version;

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** ProgramData account header: 4 (enum tag) + 8 (slot) + 1 + 32 (upgrade authority option). */
const PROGRAM_DATA_HEADER = 45;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** Programs every coin and market flow calls (beyond the built-in token programs). */
const PROGRAMS = [DYNAMIC_BONDING_CURVE_PROGRAM_ID, METAPLEX_PROGRAM_ID, DAMM_V2_PROGRAM_ID, CONDITIONAL_VAULT_PROGRAM_ID];
/**
 * Plain accounts those programs read: the DAMM v2 fee-tier configs graduation can use, and the
 * DBC pool authority, whose SOL balance on devnet pays rent for the graduated pool.
 */
const ACCOUNTS = [...DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDbcPoolAuthority(), deriveDammV2PoolAuthority()];

type CachedAccount = { lamports: number; owner: string; data: string };
/** sha256 of each cached file, or "absent" for an account the source cluster doesn't have. */
type Manifest = { sourceRpc: string; sdkVersion: string; files: Record<string, string> };

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Write to a temp file then rename, so a crash never leaves a half-written file. */
function writeAtomic(path: string, bytes: Buffer | string) {
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
}

function cacheIsValid(): boolean {
  if (process.env.SNAPSHOT_REFRESH === "1" || !existsSync(MANIFEST)) return false;
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  if (manifest.sourceRpc !== SOURCE_RPC || manifest.sdkVersion !== SDK_VERSION) return false;
  const expected = [...PROGRAMS.map((p) => `${p.toBase58()}.so`), ...ACCOUNTS.map((a) => `${a.toBase58()}.json`)];
  return expected.every((name) => {
    const hash = manifest.files[name];
    if (hash === "absent") return true;
    const path = join(CACHE_DIR, name);
    return hash !== undefined && existsSync(path) && sha256(readFileSync(path)) === hash;
  });
}

async function fetchProgramElf(connection: Connection, program: PublicKey): Promise<Buffer> {
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], UPGRADEABLE_LOADER);
  const info = await connection.getAccountInfo(programData);
  if (!info || !info.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error(`${program.toBase58()} is not an upgradeable program on ${SOURCE_RPC}`);
  }
  const elf = info.data.subarray(PROGRAM_DATA_HEADER);
  if (!elf.subarray(0, 4).equals(ELF_MAGIC)) throw new Error(`Program data for ${program.toBase58()} is not an ELF`);
  return elf;
}

/** Downloads everything from the source cluster and records it in the manifest. */
async function rebuildCache() {
  rmSync(CACHE_DIR, { recursive: true, force: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  const connection = new Connection(SOURCE_RPC, "confirmed");
  const files: Record<string, string> = {};
  for (const program of PROGRAMS) {
    const name = `${program.toBase58()}.so`;
    const elf = await fetchProgramElf(connection, program);
    writeAtomic(join(CACHE_DIR, name), elf);
    files[name] = sha256(elf);
  }
  for (const account of ACCOUNTS) {
    const name = `${account.toBase58()}.json`;
    const info = await connection.getAccountInfo(account);
    if (!info) {
      files[name] = "absent"; // recorded, so offline runs don't try to fetch it again
      continue;
    }
    const json = JSON.stringify({ lamports: info.lamports, owner: info.owner.toBase58(), data: info.data.toString("base64") });
    writeAtomic(join(CACHE_DIR, name), json);
    files[name] = sha256(json);
  }
  writeAtomic(MANIFEST, JSON.stringify({ sourceRpc: SOURCE_RPC, sdkVersion: SDK_VERSION, files } satisfies Manifest, null, 2));
}

export type OfflineSurfnetOptions = {
  solEach?: number;
  /**
   * true: a block every 400 ms, so time passes like on a real cluster (the dev chain, so the
   * launch fee falls for demos). false (default): blocks only when a transaction lands, which
   * keeps tests deterministic; tests move time explicitly with timeTravelToTimestamp.
   */
  realTimeClock?: boolean;
};

/** Real Solana's target slot time. */
const SLOT_TIME_MS = 400;

/** Starts an offline surfnet with memestream's dependencies loaded, and funds `wallets`. */
export async function startOfflineSurfnet(
  wallets: Keypair[],
  { solEach = 10, realTimeClock = false }: OfflineSurfnetOptions = {},
): Promise<Surfnet> {
  if (!cacheIsValid()) await rebuildCache();
  const surfnet = Surfnet.startWithConfig(
    realTimeClock ? { offline: true, blockProductionMode: "clock", slotTimeMs: SLOT_TIME_MS } : { offline: true },
  );
  for (const program of PROGRAMS) {
    surfnet.deploy({ programId: program.toBase58(), soBytes: readFileSync(join(CACHE_DIR, `${program.toBase58()}.so`)) });
  }
  for (const account of ACCOUNTS) {
    const path = join(CACHE_DIR, `${account.toBase58()}.json`);
    if (!existsSync(path)) continue; // recorded as absent on the source cluster
    const cached = JSON.parse(readFileSync(path, "utf8")) as CachedAccount;
    surfnet.setAccount(account.toBase58(), cached.lamports, Buffer.from(cached.data, "base64"), cached.owner);
  }
  surfnet.fundSolMany(wallets.map((w) => ({ address: w.publicKey.toBase58(), lamports: solEach * LAMPORTS_PER_SOL })));
  return surfnet;
}
