import assert from "node:assert/strict";
import { test } from "node:test";
import { pollUntil } from "./poll";

test("resolves with the first defined value, retrying past errors", async () => {
  let calls = 0;
  const result = await pollUntil(
    async () => {
      calls++;
      if (calls === 1) throw new Error("blip");
      return calls === 3 ? "done" : undefined;
    },
    { timeoutMs: 1_000, intervalMs: 1 },
  );
  assert.equal(result, "done");
  assert.equal(calls, 3);
});

test("resolves undefined after the timeout", async () => {
  assert.equal(await pollUntil(async () => undefined, { timeoutMs: 20, intervalMs: 5 }), undefined);
});
