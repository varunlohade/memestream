import assert from "node:assert/strict";
import { test } from "node:test";
import { chunks } from "./chunks";

test("splits into pieces of at most the size, keeping order (250 coins → 3 RPC calls)", () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  const pieces = chunks(items, 100);
  assert.deepEqual(pieces.map((p) => p.length), [100, 100, 50]);
  assert.deepEqual(pieces.flat(), items);
  assert.deepEqual(chunks([], 100), []);
});
