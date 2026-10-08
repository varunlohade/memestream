import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStreamCoin } from "./launch";

const valid = { name: "Friday Night Ranked", symbol: "FNR", uri: "https://example.com/fnr.json" };

test("trims fields", () => {
  const coin = parseStreamCoin({ name: "  Ranked  ", symbol: " FNR ", uri: " https://x.io/a.json " });
  assert.deepEqual(coin, { name: "Ranked", symbol: "FNR", uri: "https://x.io/a.json" });
});

test("rejects blank fields", () => {
  assert.throws(() => parseStreamCoin({ ...valid, name: "   " }), /Name is required/);
  assert.throws(() => parseStreamCoin({ ...valid, uri: "" }), /Metadata URI is required/);
});

test("limits are in bytes, so emoji count as several", () => {
  // 8 emoji = 8 UTF-16 pairs (16 units) but 32 bytes: fits the name, not the symbol.
  const eightEmoji = "🔥".repeat(8);
  assert.doesNotThrow(() => parseStreamCoin({ ...valid, name: eightEmoji }));
  assert.throws(() => parseStreamCoin({ ...valid, name: `${eightEmoji}!` }), /at most 32 bytes/);
  assert.throws(() => parseStreamCoin({ ...valid, symbol: "🔥🔥🔥" }), /at most 10 bytes/);
});
