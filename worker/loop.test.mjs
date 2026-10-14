import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { callOnce, INTERVAL_MS, MAX_BACKOFF_MS, nextWait, runLoop, TIMEOUT_MS } from "./loop.mjs";

const SECRET = "s".repeat(40);
const TICK = [{ name: "tick", url: "https://example.test/api/predictions/tick" }];
/** Lets pending promise callbacks run (setImmediate is not faked). */
const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};
/** Moves the fake clock in 1 s steps, letting the loop run between them. */
async function advance(ms) {
  for (let t = 0; t < ms; t += 1_000) {
    mock.timers.tick(1_000);
    await flush();
  }
}
/** After a stop: moves the clock until the loop ends (a call in flight still ends first). */
async function finish(running) {
  let ended = false;
  running.then(() => (ended = true));
  for (let i = 0; !ended && i < 120; i++) await advance(1_000);
  assert.ok(ended, "the loop stops");
}
/** A fetch that answers `status` after `delayMs` (on the fake clock) and rejects when aborted. */
function fakeFetch(status, delayMs = 0, seen = { calls: 0, inFlight: 0, maxInFlight: 0, headers: [] }) {
  const doFetch = (_url, init) =>
    new Promise((resolve, reject) => {
      seen.calls++;
      seen.inFlight++;
      seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
      seen.headers.push(init.headers.authorization);
      let open = true;
      const done = (fn) => (open && seen.inFlight--, (open = false), fn());
      const timer = setTimeout(() => done(() => resolve(new Response("{}", { status: typeof status === "function" ? status() : status }))), delayMs);
      init.signal.addEventListener("abort", () => (clearTimeout(timer), done(() => reject(new DOMException("aborted", "AbortError")))));
    });
  return { doFetch, seen };
}

test("nextWait: the rest of the interval after a good tick; doubling after failures, capped", () => {
  assert.equal(nextWait(0, 5_000), INTERVAL_MS - 5_000);
  assert.equal(nextWait(0, INTERVAL_MS + 1), 0);
  assert.deepEqual([1, 2, 3, 4, 10].map((f) => nextWait(f, 0)), [120_000, 240_000, 480_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
});

test("callOnce: bearer secret sent, one log line with status and time, never the secret; cut off at the timeout", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const lines = [];
  const ok = fakeFetch(200);
  const done = callOnce(TICK[0], SECRET, { fetch: ok.doFetch, log: (l) => lines.push(l) });
  await flush();
  mock.timers.tick(0);
  assert.equal(await done, true);
  assert.deepEqual(ok.seen.headers, [`Bearer ${SECRET}`]);
  const hung = fakeFetch(200, 10 * TIMEOUT_MS);
  const late = callOnce(TICK[0], SECRET, { fetch: hung.doFetch, log: (l) => lines.push(l) });
  await flush();
  mock.timers.tick(TIMEOUT_MS);
  assert.equal(await late, false);
  assert.match(lines[0], /^tick 200 \d+ms$/);
  assert.match(lines[1], /^tick failed \(timeout\)/);
  assert.ok(lines.every((l) => !l.includes(SECRET)));
});

test("runLoop: ticks never overlap, even when a call takes longer than the interval", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const slow = fakeFetch(200, 15_000);
  const stop = new AbortController();
  const ticks = [];
  const running = runLoop({ targets: [...TICK, { name: "close-due", url: "https://example.test/c" }], secret: SECRET, signal: stop.signal, fetch: slow.doFetch, log: () => {}, onTick: (r) => ticks.push(r) });
  await advance(5 * INTERVAL_MS);
  stop.abort();
  await finish(running);
  assert.equal(slow.seen.maxInFlight, 1, "one call at a time");
  assert.ok(ticks.length >= 4 && ticks.length <= 6, `${ticks.length} ticks in 5 minutes`);
  assert.ok(ticks.every((r) => r.ok && r.wait === INTERVAL_MS - 30_000), "the wait counts the time the tick took");
});

test("runLoop: failures back off (doubling, capped); a good tick resets it", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  let status = 503;
  const { doFetch, seen } = fakeFetch(() => status);
  const stop = new AbortController();
  const ticks = [];
  const lines = [];
  const running = runLoop({ targets: TICK, secret: SECRET, signal: stop.signal, fetch: doFetch, log: (l) => lines.push(l), onTick: (r) => ticks.push(r) });
  await advance(2_000);
  await advance(120_000 + 240_000 + 480_000 + 2_000);
  assert.deepEqual(ticks.map((r) => r.wait), [120_000, 240_000, 480_000, MAX_BACKOFF_MS]);
  status = 200;
  await advance(MAX_BACKOFF_MS);
  stop.abort();
  await finish(running);
  const last = ticks.at(-1);
  assert.deepEqual([last.ok, last.failures], [true, 0]);
  assert.ok(last.wait > INTERVAL_MS - 2_000 && last.wait <= INTERVAL_MS, "back to the plain interval");
  assert.equal(seen.calls, ticks.length);
  assert.ok(lines.some((l) => l.startsWith("backing off 120s")));
  assert.ok(lines.every((l) => !l.includes(SECRET)));
});
