/**
 * The tick loop: every interval, POST each target URL in turn with the cron secret as a bearer
 * token. One tick at a time (the next starts only after the last one ended), each call cut off at
 * its timeout, and a pause that doubles after each failed tick (up to MAX_BACKOFF_MS). Logs one
 * line per call: its name, status and duration, never the secret.
 */

export const INTERVAL_MS = 60_000;
export const TIMEOUT_MS = 20_000;
export const MAX_BACKOFF_MS = 10 * 60_000;

/**
 * @typedef {{ name: string; url: string }} Target
 * @typedef {{ fetch?: typeof fetch; log?: (line: string) => void; now?: () => number; timeoutMs?: number }} CallDeps
 */

/** One POST to `target`; true on a 2xx answer. Never throws. */
export async function callOnce(target, secret, deps = {}) {
  const { fetch: doFetch = fetch, log = console.log, now = Date.now, timeoutMs = TIMEOUT_MS } = deps;
  const started = now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await doFetch(target.url, { method: "POST", headers: { authorization: `Bearer ${secret}` }, signal: abort.signal });
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

/** One tick: every target in turn. True only if every call succeeded. */
export async function tickOnce(targets, secret, deps = {}) {
  let ok = true;
  for (const target of targets) ok = (await callOnce(target, secret, deps)) && ok;
  return ok;
}

/** The pause before the next tick: the rest of the interval after a good tick; after `failures` bad ticks in a row, the interval doubled each time, capped. */
export function nextWait(failures, elapsedMs, intervalMs = INTERVAL_MS, maxBackoffMs = MAX_BACKOFF_MS) {
  if (failures === 0) return Math.max(0, intervalMs - elapsedMs);
  return Math.min(intervalMs * 2 ** failures, maxBackoffMs);
}

/** Resolves after `ms`, or at once when `signal` aborts. */
export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Runs ticks until `signal` aborts. Ticks never overlap: each waits for the last to end, then for
 * nextWait. `onTick` (tests) sees each tick's result.
 */
export async function runLoop({ targets, secret, signal, intervalMs = INTERVAL_MS, maxBackoffMs = MAX_BACKOFF_MS, onTick, ...deps }) {
  const now = deps.now ?? Date.now;
  let failures = 0;
  while (!signal?.aborted) {
    const started = now();
    const ok = await tickOnce(targets, secret, deps);
    failures = ok ? 0 : failures + 1;
    const wait = nextWait(failures, now() - started, intervalMs, maxBackoffMs);
    onTick?.({ ok, failures, wait });
    if (failures > 0) (deps.log ?? console.log)(`backing off ${Math.round(wait / 1000)}s after ${failures} failed tick(s)`);
    await sleep(wait, signal);
  }
}
