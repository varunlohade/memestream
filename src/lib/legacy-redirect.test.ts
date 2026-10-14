import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LEGACY_REDIRECT, legacyRedirectTarget } from "./legacy-redirect";

test("by default the judges' old link goes to the devnet site, never to www (mainnet)", () => {
  assert.equal(legacyRedirectTarget({}), DEFAULT_LEGACY_REDIRECT);
  assert.equal(legacyRedirectTarget({}), "https://devnet.memestream.lol");
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
