// The shared (Redis) limiter must never take the site down: without Redis, or with Redis
// unreachable, it falls back to per-instance buckets that still enforce the limit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIp } from "./rate-limit";

test("with Redis unreachable, limits still hold through the local fallback", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:9"; // nothing listens on the discard port
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  const { sharedLimiter } = await import("./shared-limit");
  const limiter = sharedLimiter("test-unreachable", 2, 1);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await limiter.take("ip-a"), true);
    assert.equal(limiter.lastSource(), "local");
    assert.equal(await limiter.take("ip-a"), true);
    assert.equal(await limiter.take("ip-a"), false, "burst of 2 used up");
    assert.equal(await limiter.take("ip-b"), true, "other clients unaffected");
    assert.equal(await limiter.take("ip-c", 5), false, "a cost above the burst is refused");
  } finally {
    console.warn = warn;
  }
});

test("client IP prefers headers Vercel's edge sets over the forgeable x-forwarded-for", () => {
  const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  assert.equal(clientIp(req({ "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "6.6.6.6" })), "1.1.1.1");
  assert.equal(clientIp(req({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "6.6.6.6" })), "2.2.2.2");
  assert.equal(clientIp(req({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" })), "3.3.3.3");
  assert.equal(clientIp(req({})), "local");
});
