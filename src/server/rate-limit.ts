/**
 * Small in-memory token buckets. Per server instance: good enough to stop one client from
 * hammering the RPC through us; a multi-instance deploy needs a shared store (see MAINNET-CHECKLIST).
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

  take(key: string, now = Date.now()): boolean {
    let entry = this.buckets.get(key);
    if (!entry) this.buckets.set(key, (entry = { bucket: new TokenBucket(this.capacity, this.refillPerSecond, now), seen: now }));
    entry.seen = now;
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (now - v.seen > this.idleMs) this.buckets.delete(k);
    return entry.bucket.take(1, now);
  }
}

/** Best-effort client IP behind a proxy (Vercel and most hosts set x-forwarded-for). */
export const clientIp = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";

/**
 * One RPC call budget for the whole server, shared by every route that reads the chain, so the
 * paid RPC bill has a hard cap. Set it from the RPC plan's limits on mainnet.
 */
const rpcBudget = new TokenBucket(300, 60);
export const takeRpcBudget = (calls: number) => rpcBudget.take(calls);
