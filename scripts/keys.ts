/** Local keypair files for scripts (a JSON array of secret-key bytes, as solana-keygen writes). Kept in .keys/ (git-ignored). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";

export const readKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

/** Reads a keypair file, creating a fresh keypair there (owner-only permissions) on first use. */
export function readOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) return readKeypair(path);
  mkdirSync(dirname(path), { recursive: true });
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return keypair;
}
