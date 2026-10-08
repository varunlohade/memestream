/**
 * LOCAL TESTING ONLY. A throwaway test wallet held by the dev server, so the app can be
 * clicked through on a local chain without a browser wallet extension.
 *
 * Guards, all required:
 * - MEMESTREAM_DEV_WALLET_KEY is set and NODE_ENV isn't production;
 * - the request comes from this app's own page (Origin matches MEMESTREAM_PUBLIC_URL, a localhost URL);
 * - it only signs transactions this server built in the last few minutes.
 * Run the dev server bound to 127.0.0.1 (npm run dev does) so nothing else on the network can reach it.
 *
 * Testing slow confirmations: set MEMESTREAM_DEV_SEND_DELAY_MS (e.g. 20000). The wallet then signs and
 * returns the signature at once but sends it only after the delay, so a trade stays "Confirming"
 * long enough to test a reload or a second tab mid-trade.
 */
import { readFileSync } from "node:fs";
import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { getChain, wasBuiltHere } from "@/server/chain";
import { withRpcGuard } from "@/server/rpc-guard";
import { fail, jsonBody, ok } from "../respond";

let wallet: Keypair | null | undefined;

function loadWallet(): Keypair | null {
  if (wallet !== undefined) return wallet;
  const keyPath = process.env.MEMESTREAM_DEV_WALLET_KEY;
  const publicUrl = process.env.MEMESTREAM_PUBLIC_URL ?? "";
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl);
  wallet =
    keyPath && local && process.env.NODE_ENV !== "production"
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))))
      : null;
  return wallet;
}

/** Same-origin only: blocks other websites (and DNS-rebinding pages) from using the wallet. */
const fromOurPage = (request: Request) => request.headers.get("origin") === process.env.MEMESTREAM_PUBLIC_URL;

const disabled = () => Response.json({ error: "Dev wallet disabled" }, { status: 404 });

export const GET = withRpcGuard({ name: "dev-wallet-get", burst: 20, perSecond: 2 }, async () => {
  const devWallet = loadWallet();
  if (!devWallet) return disabled();
  return ok({ address: devWallet.publicKey.toBase58() });
});

export const POST = withRpcGuard({ name: "dev-wallet-post", burst: 10, perSecond: 1, calls: 1 }, async (request: Request) => {
  const devWallet = loadWallet();
  if (!devWallet || !fromOurPage(request)) return disabled();
  try {
    const { transaction } = await jsonBody(request);
    if (typeof transaction !== "string") return Response.json({ error: "Missing transaction" }, { status: 400 });
    const tx = Transaction.from(Buffer.from(transaction, "base64"));
    if (!wasBuiltHere(tx)) return Response.json({ error: "Not a transaction this server built" }, { status: 403 });
    tx.partialSign(devWallet);
    const { connection } = getChain();
    const delayMs = Number(process.env.MEMESTREAM_DEV_SEND_DELAY_MS ?? 0);
    if (delayMs > 0) {
      setTimeout(() => void connection.sendRawTransaction(tx.serialize()).catch(console.error), delayMs);
      return ok({ signature: bs58.encode(tx.signature as Buffer) });
    }
    // Return as soon as it's sent, like a real wallet; the UI confirms the same way for both.
    return ok({ signature: await connection.sendRawTransaction(tx.serialize()) });
  } catch (error) {
    return fail(error);
  }
});
