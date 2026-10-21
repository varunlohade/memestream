/** Contract tests: the daily stream job's coins and questions pass the app's own rules (imported from src/lib). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStreamLink } from "../src/lib/stream-link.ts";
import { isCanonicalTicker } from "../src/lib/short-link.ts";
import { cleanQuestion } from "../src/lib/predictions/rules.ts";
import { sessionMessage as appSessionMessage } from "../src/lib/predictions/message.ts";
import { sessionMessage } from "./job.mjs";
import { coinFor, rotation, STREAMS, utcDay } from "./streams.mjs";

const DAY = 86_400_000;
/** Dates with the longest names and two-digit days. */
const DATES = ["2026-09-30T23:59:59Z", "2026-12-31T00:00:00Z", "2027-01-01T09:00:00Z", "2026-10-22T09:00:00Z"].map(Date.parse);

test("every stream is a valid YouTube link with 3+ questions the app accepts as typed", () => {
  assert.ok(STREAMS.length >= 4);
  assert.equal(new Set(STREAMS.map((s) => s.prefix)).size, STREAMS.length);
  for (const s of STREAMS) {
    assert.equal(parseStreamLink(s.url)?.platform, "youtube", s.url);
    assert.equal(parseStreamLink(s.url)?.url, s.url);
    assert.ok(s.questions.length >= 3, s.key);
    for (const q of s.questions) {
      const cleaned = cleanQuestion(q);
      assert.ok(cleaned.ok, `${q}: ${cleaned.ok ? "" : cleaned.error}`);
      assert.equal(cleaned.question, q, "sent as the app stores it, so the job finds it in the live list");
    }
  }
});

test("coinFor: 'Beach cam · Oct 22' and BCH261022; every ticker and name fits the launch limits", () => {
  const beach = STREAMS.find((s) => s.key === "beach");
  assert.deepEqual(coinFor(beach, Date.parse("2026-10-22T09:00:00Z")), { name: "Beach cam · Oct 22", symbol: "BCH261022", streamUrl: beach.url });
  assert.notEqual(coinFor(beach, Date.parse("2027-10-22T09:00:00Z")).symbol, "BCH261022", "the year keeps next year's ticker unique");
  for (const s of STREAMS) {
    assert.ok(s.prefix.length <= 4, s.prefix);
    for (const t of DATES) {
      const c = coinFor(s, t);
      assert.ok(isCanonicalTicker(c.symbol), c.symbol);
      assert.ok(Buffer.byteLength(c.name) <= 32, c.name);
    }
  }
});

test("rotation: a different first stream each UTC day, every stream once; day 0 is 2026-10-01", () => {
  const t = Date.parse("2026-10-22T09:00:00Z");
  const firsts = Array.from({ length: STREAMS.length }, (_, i) => rotation(t + i * DAY)[0].key);
  assert.equal(new Set(firsts).size, STREAMS.length);
  assert.deepEqual(new Set(rotation(t).map((s) => s.key)), new Set(STREAMS.map((s) => s.key)));
  assert.equal(rotation(t)[0], rotation(Date.parse("2026-10-22T23:59:59Z"))[0]);
  assert.equal(rotation(Date.parse("2026-10-01T12:00:00Z"))[0], STREAMS[0]);
  assert.equal(rotation(Date.parse("2026-09-30T12:00:00Z"))[0], STREAMS.at(-1), "days before the epoch rotate too");
  assert.deepEqual(utcDay(t), [Date.parse("2026-10-22T00:00:00Z"), Date.parse("2026-10-23T00:00:00Z")]);
});

test("the sign-in message is exactly the app's", () => {
  const r = { domain: "www.memestream.lol", wallet: "11111111111111111111111111111111", nonce: "a".repeat(32), expiresAt: Date.parse("2026-10-22T09:00:00Z") };
  assert.equal(sessionMessage(r), appSessionMessage(r));
});
