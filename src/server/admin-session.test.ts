import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, test } from "node:test";
import bs58 from "bs58";
import { MESSAGE_TTL_MS, sessionMessage } from "@/lib/predictions/message";
import { POST as sessionRoute } from "@/app/api/admin/session/route";
import { GET as feesRoute } from "@/app/api/admin/fees/route";
import { AdminSessionError, adminSession, signedInAdmin } from "./admin-session";

const NOW = Date.now();
const KEYS = ["MEMESTREAM_PREDICTIONS", "MEMESTREAM_PREDICTIONS_SECRET", "MEMESTREAM_PUBLIC_URL", "MEMESTREAM_ADMIN_WALLETS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
  const signed = () => {
    const message = sessionMessage({ domain: "www.memestream.lol", wallet: address, nonce: "0123456789abcdef0123456789abcdef", expiresAt: NOW + MESSAGE_TTL_MS });
    return { message, signature: bs58.encode(sign(null, Buffer.from(message), privateKey)) };
  };
  return { address, signed };
}

function setEnv(admin: string) {
  delete process.env.MEMESTREAM_PREDICTIONS; // predictions OFF: admin sign-in must still work
  process.env.MEMESTREAM_PREDICTIONS_SECRET = "s".repeat(40);
  process.env.MEMESTREAM_PUBLIC_URL = "https://www.memestream.lol";
  process.env.MEMESTREAM_ADMIN_WALLETS = admin;
}

test("an admin signs in and is recognised with predictions turned off", async () => {
  const owner = wallet();
  setEnv(owner.address);
  const { message, signature } = owner.signed();
  const response = await sessionRoute(new Request("https://www.memestream.lol/api/admin/session", { method: "POST", body: JSON.stringify({ message, signature }) }), {});
  assert.equal(response.status, 200);
  const { token, wallet: who } = (await response.json()) as { token: string; wallet: string };
  assert.equal(who, owner.address);
  const authed = new Request("https://www.memestream.lol/api/admin/fees", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(signedInAdmin(authed, NOW), owner.address);
});

test("a non-admin can't get an admin session, and the fee API refuses requests without one", async () => {
  const owner = wallet();
  const other = wallet();
  setEnv(owner.address);
  const { message, signature } = other.signed();
  assert.throws(() => adminSession(message, signature, NOW), (e: unknown) => e instanceof AdminSessionError && e.status === 403);
  const anonymous = await feesRoute(new Request("https://www.memestream.lol/api/admin/fees"), {});
  assert.equal(anonymous.status, 401);
  const forged = await feesRoute(new Request("https://www.memestream.lol/api/admin/fees", { headers: { authorization: `Bearer ${owner.address}.${NOW + 60_000}.forged` } }), {});
  assert.equal(forged.status, 401);
});
