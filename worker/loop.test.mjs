import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mock, test } from "node:test";
import { callOnce, CLOSE_DUE_TIMEOUT_MS, INTERVAL_MS, MAX_BACKOFF_MS, nextWait, runLoops, runTarget, sleep, targetsFrom, TICK_TIMEOUT_MS } from "./loop.mjs";

const SECRET = "s".repeat(40);
const TICK = { name: "tick", url: "https://example.test/api/predictions/tick", timeoutMs: TICK_TIMEOUT_MS };
const CLOSE_DUE = { name: "close-due", url: "https://example.test/api/markets/close-due", timeoutMs: CLOSE_DUE_TIMEOUT_MS };
/** Lets pending promise callbacks run (setImmediate is not faked). */
const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};
/** Moves the fake clock in 1 s steps, letting the loops run between them. */
async function advance(ms) {
  for (let t = 0; t < ms; t += 1_000) {
    mock.timers.tick(1_000);
    await flush();
  }
}
/** After a stop: moves the clock until the loops end (a call in flight still ends first). */
async function finish(running) {
  let ended = false;
  running.then(() => (ended = true));
  for (let i = 0; !ended && i < 400; i++) await advance(1_000);
  assert.ok(ended, "the loop stops");
}
/** A fetch per URL: answers `status` (or status()) after `delayMs` on the fake clock; rejects when aborted. */
function fakeFetch(plans) {
  const seen = { calls: {}, inFlight: {}, maxInFlight: {}, inits: [] };
  const doFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const name = plans[url] ? url : "*";
      const { status, delayMs = 0 } = plans[name];
      seen.inits.push(init);
      seen.calls[url] = (seen.calls[url] ?? 0) + 1;
      seen.inFlight[url] = (seen.inFlight[url] ?? 0) + 1;
      seen.maxInFlight[url] = Math.max(seen.maxInFlight[url] ?? 0, seen.inFlight[url]);
      let open = true;
      const done = (fn) => (open && seen.inFlight[url]--, (open = false), fn());
      const timer = setTimeout(() => done(() => resolve(new Response("{}", { status: typeof status === "function" ? status() : status }))), delayMs);
      init.signal.addEventListener("abort", () => (clearTimeout(timer), done(() => reject(new DOMException("aborted", "AbortError")))));
    });
  return { doFetch, seen };
}
const enable = (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
};

test("nextWait: the rest of the interval after a good call; doubling after failures, capped", () => {
  assert.equal(nextWait(0, 5_000), INTERVAL_MS - 5_000);
  assert.equal(nextWait(0, INTERVAL_MS + 1), 0);
  assert.deepEqual([1, 2, 3, 4, 10].map((f) => nextWait(f, 0)), [120_000, 240_000, 480_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
});

test("targetsFrom: https only, close-due on the same host, timeouts above each route's maxDuration", () => {
  assert.deepEqual(targetsFrom(TICK.url), [TICK]);
  assert.deepEqual(targetsFrom(TICK.url, CLOSE_DUE.url), [TICK, CLOSE_DUE]);
  assert.ok(TICK_TIMEOUT_MS > 120_000 && CLOSE_DUE_TIMEOUT_MS > 300_000);
  assert.throws(() => targetsFrom("http://example.test/api/predictions/tick"), /https/);
  assert.throws(() => targetsFrom(TICK.url, "https://evil.test/api/markets/close-due"), /same host/);
  assert.throws(() => targetsFrom(undefined), /not a URL/);
});

test("callOnce: bearer secret, no redirects, one log line with status and time, never the secret; cut off at the target's timeout", async (t) => {
  enable(t);
  const lines = [];
  const ok = fakeFetch({ "*": { status: 200 } });
  const done = callOnce(TICK, SECRET, { fetch: ok.doFetch, log: (l) => lines.push(l) });
  await advance(1_000);
  assert.equal(await done, true);
  assert.deepEqual([ok.seen.inits[0].headers.authorization, ok.seen.inits[0].redirect, ok.seen.inits[0].method], [`Bearer ${SECRET}`, "error", "POST"]);
  const slow = fakeFetch({ "*": { status: 200, delayMs: 200_000 } });
  const late = callOnce(TICK, SECRET, { fetch: slow.doFetch, log: (l) => lines.push(l) });
  await advance(TICK_TIMEOUT_MS);
  assert.equal(await late, false);
  assert.match(lines[0], /^tick 200 \d+ms$/);
  assert.match(lines[1], /^tick failed \(timeout\) 130000ms$/);
  assert.ok(lines.every((l) => !l.includes(SECRET)));
});

test("runTarget: calls never overlap, even when one takes longer than the interval", async (t) => {
  enable(t);
  const { doFetch, seen } = fakeFetch({ "*": { status: 200, delayMs: 50_000 } });
  const stop = new AbortController();
  const ticks = [];
  const running = runTarget({ target: TICK, secret: SECRET, signal: stop.signal, fetch: doFetch, log: () => {}, onTick: (r) => ticks.push(r) });
  await advance(5 * INTERVAL_MS);
  stop.abort();
  await finish(running);
  assert.equal(seen.maxInFlight[TICK.url], 1, "one call at a time");
  assert.ok(ticks.length >= 4 && ticks.every((r) => r.ok), `${ticks.length} good calls in 5 minutes`);
});

test("runTarget: failures back off (doubling, capped); a good call resets it", async (t) => {
  enable(t);
  let status = 503;
  const { doFetch, seen } = fakeFetch({ "*": { status: () => status } });
  const stop = new AbortController();
  const ticks = [];
  const lines = [];
  const running = runTarget({ target: TICK, secret: SECRET, signal: stop.signal, fetch: doFetch, log: (l) => lines.push(l), onTick: (r) => ticks.push(r) });
  await advance(2_000);
  await advance(120_000 + 240_000 + 480_000 + 2_000);
  assert.deepEqual(ticks.map((r) => r.wait), [120_000, 240_000, 480_000, MAX_BACKOFF_MS]);
  status = 200;
  await advance(MAX_BACKOFF_MS);
  stop.abort();
  await finish(running);
  const last = ticks.at(-1);
  assert.deepEqual([last.ok, last.failures], [true, 0]);
  assert.equal(seen.calls[TICK.url], ticks.length);
  assert.ok(lines.some((l) => l.startsWith("tick: backing off 120s")));
  assert.ok(lines.every((l) => !l.includes(SECRET)));
});

test("runLoops: each target on its own schedule: a slow, failing close-due never delays the tick", async (t) => {
  enable(t);
  const { doFetch, seen } = fakeFetch({ [TICK.url]: { status: 200 }, [CLOSE_DUE.url]: { status: 500, delayMs: 200_000 } });
  const stop = new AbortController();
  const ticks = [];
  const running = runLoops({ targets: [TICK, CLOSE_DUE], secret: SECRET, signal: stop.signal, fetch: doFetch, log: () => {}, onTick: (r) => ticks.push(r) });
  await advance(10 * INTERVAL_MS);
  stop.abort();
  await finish(running);
  assert.ok(seen.calls[TICK.url] >= 9, `tick called ${seen.calls[TICK.url]} times in 10 minutes`);
  assert.ok(ticks.filter((r) => r.name === "tick").every((r) => r.ok && r.failures === 0), "the tick never backs off for close-due");
  assert.ok(ticks.some((r) => r.name === "close-due" && r.failures > 0), "close-due backs off on its own");
});

test("sleep: no timer or abort listener is left behind, whether it ends or is stopped", async (t) => {
  enable(t);
  const stop = new AbortController();
  for (let i = 0; i < 3; i++) {
    const slept = sleep(1_000, stop.signal);
    await advance(1_000);
    await slept;
  }
  assert.equal(getEventListeners(stop.signal, "abort").length, 0, "no listeners after normal ends");
  const stopped = sleep(60_000, stop.signal);
  stop.abort();
  await stopped;
  assert.equal(getEventListeners(stop.signal, "abort").length, 0);
});
