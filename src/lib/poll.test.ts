import assert from "node:assert/strict";
import { test } from "node:test";
import { newestOnly, pollUntil } from "./poll";

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

test("newestOnly: a slow, older answer (an earlier poll, or another wallet's request) never lands", async () => {
  const requests = newestOnly();
  const landed: string[] = [];
  const request = async (name: string, delayMs: number) => {
    const current = requests.start();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (current()) landed.push(name);
  };
  await Promise.all([request("wallet A, slow", 30), request("wallet B", 5)]);
  assert.deepEqual(landed, ["wallet B"]);
  await request("wallet B, next poll", 0);
  assert.deepEqual(landed, ["wallet B", "wallet B, next poll"]);
});
