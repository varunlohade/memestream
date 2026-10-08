/** One polling loop for the whole codebase. Pure; works in browser, server, tests and scripts. */

export type PollOptions = { timeoutMs: number; intervalMs: number };

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
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
