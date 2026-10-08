import assert from "node:assert/strict";
import { test } from "node:test";
import { shareInFlight } from "./in-flight";

test("concurrent callers share one read", async () => {
  const inFlight = new Map<string, Promise<number>>();
  let reads = 0;
  const read = () => new Promise<number>((resolve) => setTimeout(() => resolve(++reads), 5));
  const results = await Promise.all([1, 2, 3].map(() => shareInFlight(inFlight, "k", read)));
  assert.deepEqual(results, [1, 1, 1]);
  assert.equal(inFlight.size, 0, "removed once settled");
});

test("a failed read is dropped at once: the next caller retries and succeeds", async () => {
  const inFlight = new Map<string, Promise<string>>();
  let attempt = 0;
  const read = async () => {
    attempt++;
    if (attempt === 1) throw new Error("RPC down");
    return "ok";
  };
  const first = shareInFlight(inFlight, "k", read);
  const waiter = shareInFlight(inFlight, "k", read); // joins the failing read
  await assert.rejects(first, /RPC down/);
  await assert.rejects(waiter, /RPC down/);
  assert.equal(inFlight.size, 0, "the rejected read is gone");
  assert.equal(await shareInFlight(inFlight, "k", read), "ok");
  assert.equal(attempt, 2);
});
