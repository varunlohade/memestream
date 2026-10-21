/**
 * The tick loops: one per target URL, each on its own schedule and its own backoff, so a slow or
 * failing target never holds up the other. Every interval a loop POSTs its URL with the cron secret
 * as a bearer token (no redirects followed). One call at a time per target (the next starts only
 * after the last one ended), each cut off at its own timeout (above the route's maxDuration, so a
 * healthy run is never counted as a failure), and a pause that doubles after each failed call (up to
 * MAX_BACKOFF_MS). Logs one line per call: its name, status and duration, never the secret.
 */

export const INTERVAL_MS = 60_000;
/** The tick route's maxDuration is 120 s (a video clip and its description), close-due's 300 s: each target waits a little longer. */
export const TICK_TIMEOUT_MS = 130_000;
export const CLOSE_DUE_TIMEOUT_MS = 305_000;
export const MAX_BACKOFF_MS = 10 * 60_000;

/**
 * @typedef {{ name: string; url: string; timeoutMs: number }} Target
 * @typedef {{ fetch?: typeof fetch; log?: (line: string) => void; now?: () => number }} CallDeps
 */

/** One POST to `target`; true on a 2xx answer. Never throws. */
export async function callOnce(target, secret, deps = {}) {
  const { fetch: doFetch = fetch, log = console.log, now = Date.now } = deps;
  const started = now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), target.timeoutMs);
  try {
    const response = await doFetch(target.url, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${secret}` }, signal: abort.signal });
    await response.body?.cancel().catch(() => {});
    log(`${target.name} ${response.status} ${now() - started}ms`);
    return response.ok;
  } catch (error) {
    const why = abort.signal.aborted ? "timeout" : error instanceof Error ? error.name : "error";
    log(`${target.name} failed (${why}) ${now() - started}ms`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The pause before the next call: the rest of the interval after a good one; after `failures` bad ones in a row, the interval doubled each time, capped. */
export function nextWait(failures, elapsedMs, intervalMs = INTERVAL_MS, maxBackoffMs = MAX_BACKOFF_MS) {
  if (failures === 0) return Math.max(0, intervalMs - elapsedMs);
  return Math.min(intervalMs * 2 ** failures, maxBackoffMs);
}

/** Resolves after `ms`, or at once when `signal` aborts; either way the timer and the abort listener are gone. */
export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Calls one target until `signal` aborts. Calls never overlap: each waits for the last to end, then
 * for nextWait. `onTick` (tests) sees each call's result.
 */
export async function runTarget({ target, secret, signal, intervalMs = INTERVAL_MS, maxBackoffMs = MAX_BACKOFF_MS, onTick, ...deps }) {
  const now = deps.now ?? Date.now;
  let failures = 0;
  while (!signal?.aborted) {
    const started = now();
    const ok = await callOnce(target, secret, deps);
    failures = ok ? 0 : failures + 1;
    const wait = nextWait(failures, now() - started, intervalMs, maxBackoffMs);
    onTick?.({ name: target.name, ok, failures, wait });
    if (failures > 0) (deps.log ?? console.log)(`${target.name}: backing off ${Math.round(wait / 1000)}s after ${failures} failed call(s)`);
    await sleep(wait, signal);
  }
}

/** Every target on its own loop, side by side, until `signal` aborts. */
export const runLoops = ({ targets, ...rest }) => Promise.all(targets.map((target) => runTarget({ target, ...rest })));

/**
 * The targets from the environment's URLs: both https, on the same host (the secret goes to one
 * site only). Throws a short message when they aren't.
 */
export function targetsFrom(tickUrl, closeDueUrl) {
  const parse = (name, value) => {
    let url;
    try {
      url = new URL(value ?? "");
    } catch {
      throw new Error(`${name} is not a URL`);
    }
    if (url.protocol !== "https:") throw new Error(`${name} must be https`);
    return url;
  };
  const tick = parse("MEMESTREAM_TICK_URL", tickUrl);
  const targets = [{ name: "tick", url: tick.href, timeoutMs: TICK_TIMEOUT_MS }];
  if (closeDueUrl) {
    const closeDue = parse("MEMESTREAM_CLOSE_DUE_URL", closeDueUrl);
    if (closeDue.host !== tick.host) throw new Error("MEMESTREAM_CLOSE_DUE_URL must be on the same host as MEMESTREAM_TICK_URL");
    targets.push({ name: "close-due", url: closeDue.href, timeoutMs: CLOSE_DUE_TIMEOUT_MS });
  }
  return targets;
}
