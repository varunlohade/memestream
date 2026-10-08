/**
 * Small in-memory token buckets, per server instance. They're the fallback for the shared
 * Redis limits (shared-limit.ts) and what local dev and tests use.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Takes `cost` tokens if available. */
  take(cost = 1, now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** One bucket per key (e.g. client IP), forgotten after `idleMs` without use. */
export class KeyedLimiter {
  private buckets = new Map<string, { bucket: TokenBucket; seen: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly idleMs = 10 * 60_000,
  ) {}

  take(key: string, now = Date.now(), cost = 1): boolean {
    let entry = this.buckets.get(key);
    if (!entry) this.buckets.set(key, (entry = { bucket: new TokenBucket(this.capacity, this.refillPerSecond, now), seen: now }));
    entry.seen = now;
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (now - v.seen > this.idleMs) this.buckets.delete(k);
    return entry.bucket.take(cost, now);
  }
}

/**
 * The client's IP. On Vercel, x-vercel-forwarded-for and x-real-ip are set by Vercel's edge and
 * can't be forged by the client (x-forwarded-for can be, elsewhere). Then the usual headers.
 */
export const clientIp = (request: Request) =>
  request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
  request.headers.get("x-real-ip") ||
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  "local";
