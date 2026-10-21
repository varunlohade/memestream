import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LEGACY_REDIRECT, legacyRedirectTarget } from "./legacy-redirect";

const MAINNET = { MEMESTREAM_WALLET_CHAIN: "solana:mainnet" };

test("on mainnet, by default the judges' old link goes to the devnet site, never to www (mainnet)", () => {
  assert.equal(legacyRedirectTarget(MAINNET), DEFAULT_LEGACY_REDIRECT);
  assert.equal(legacyRedirectTarget(MAINNET), "https://devnet.memestream.lol");
});

test("on devnet (www is still devnet), by default the old link keeps going to www", () => {
  assert.equal(legacyRedirectTarget({}), "https://www.memestream.lol");
  assert.equal(legacyRedirectTarget({ MEMESTREAM_WALLET_CHAIN: "solana:devnet" }), "https://www.memestream.lol");
});

test("env overrides the default on both networks", () => {
  assert.equal(legacyRedirectTarget({ ...MAINNET, MEMESTREAM_LEGACY_REDIRECT: "off" }), null);
  assert.equal(legacyRedirectTarget({ MEMESTREAM_LEGACY_REDIRECT: "https://devnet.memestream.lol" }), "https://devnet.memestream.lol");
});

test("the target comes from env, as an origin", () => {
  assert.equal(legacyRedirectTarget({ MEMESTREAM_LEGACY_REDIRECT: "https://devnet.memestream.lol/" }), "https://devnet.memestream.lol");
  assert.equal(legacyRedirectTarget({ MEMESTREAM_LEGACY_REDIRECT: "off" }), null);
});

test("a target that would loop, or isn't https, stops the build", () => {
  assert.throws(() => legacyRedirectTarget({ MEMESTREAM_LEGACY_REDIRECT: "https://memestream-iota.vercel.app" }), /loop/);
  assert.throws(() => legacyRedirectTarget({ MEMESTREAM_LEGACY_REDIRECT: "http://devnet.memestream.lol" }), /https/);
  assert.throws(() => legacyRedirectTarget({ MEMESTREAM_LEGACY_REDIRECT: "devnet" }), /not a URL/);
});
