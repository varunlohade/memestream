/**
 * Shares one async read per key among concurrent callers. The entry is removed as soon as the read
 * settles, fulfilled or rejected, so a failure reaches only the callers already waiting and the
 * next caller starts a fresh read.
 */
export function shareInFlight<T>(inFlight: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let pending = inFlight.get(key);
  if (!pending) {
    pending = read().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}
