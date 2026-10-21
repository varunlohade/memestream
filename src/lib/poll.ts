/** One polling loop for the whole codebase. Pure; works in browser, server, tests and scripts. */

export type PollOptions = { timeoutMs: number; intervalMs: number };

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls `check` until it returns a value (not undefined), then resolves with it.
 * Errors thrown by `check` count as "not yet" (a network blip shouldn't end the wait).
 * Resolves undefined if `timeoutMs` passes first.
 */
export async function pollUntil<T>(check: () => Promise<T | undefined>, { timeoutMs, intervalMs }: PollOptions): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await check();
      if (result !== undefined) return result;
    } catch {
      // transient failure: try again on the next tick
    }
    if (Date.now() + intervalMs > deadline) return undefined;
    await sleep(intervalMs);
  }
}

/**
 * For a value polled and refreshed by hand: only the newest request's answer may land. `start()`
 * returns a check that stays true until a newer request starts, so a slow, older answer (an earlier
 * poll, or a request made for another wallet) is dropped.
 */
export function newestOnly(): { start: () => () => boolean } {
  let latest = 0;
  return {
    start() {
      const mine = ++latest;
      return () => mine === latest;
    },
  };
}
