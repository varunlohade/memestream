import assert from "node:assert/strict";
import { test } from "node:test";
import { jevAnswer, REASON_IDS } from "./jev-fake";
import { APPROVE_MIN_CONFIDENCE, parseVerdict, ReviewFailed, reviewClient, TYPESAFE_URL } from "./review";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

test("parseVerdict: APPROVE at enough confidence approves; low confidence or REJECT does not", () => {
  assert.deepEqual(parseVerdict(jevAnswer("APPROVE", 0.95)), { approved: true });
  assert.deepEqual(parseVerdict(jevAnswer("APPROVE", APPROVE_MIN_CONFIDENCE)), { approved: true });
  assert.deepEqual(parseVerdict(jevAnswer("APPROVE", 0.55, "NOT_YES_NO")), { approved: false, reason: "NOT_YES_NO", text: "Not approved: not a clear yes/no question" });
  assert.deepEqual(parseVerdict(jevAnswer("REJECT", 0.9, "HATE")), { approved: false, reason: "HATE", text: "Not approved: hateful" });
});

test("parseVerdict: anything malformed throws, never approves", () => {
  const good = jevAnswer("APPROVE");
  const broken: [string, (a: ReturnType<typeof jevAnswer>) => unknown][] = [
    ["no answers", () => ({})],
    ["null", () => null],
    ["unknown choice", (a) => ({ answers: { ...a.answers, verdict: { ...a.answers.verdict, choice: "MAYBE" } } })],
    ["missing id", (a) => ({ answers: { ...a.answers, verdict: { ...a.answers.verdict, probabilities: { APPROVE: 1 } } } })],
    ["extra id", (a) => ({ answers: { ...a.answers, verdict: { ...a.answers.verdict, probabilities: { APPROVE: 0.9, REJECT: 0.1, MAYBE: 0 } } } })],
    ["sum off", (a) => ({ answers: { ...a.answers, verdict: { ...a.answers.verdict, probabilities: { APPROVE: 0.9, REJECT: 0.5 } } } })],
    ["above 1", (a) => ({ answers: { ...a.answers, verdict: { ...a.answers.verdict, confidence: 1.5 } } })],
    ["string number", (a) => ({ answers: { ...a.answers, verdict: { ...a.answers.verdict, confidence: "0.9" } } })],
    ["NaN", (a) => ({ answers: { ...a.answers, verdict: { ...a.answers.verdict, probabilities: { APPROVE: NaN, REJECT: 0.1 } } } })],
    ["choice not the top", (a) => ({ answers: { ...a.answers, verdict: { ...a.answers.verdict, probabilities: { APPROVE: 0.1, REJECT: 0.9 } } } })],
    ["no reason", (a) => ({ answers: { verdict: a.answers.verdict } })],
  ];
  for (const [name, mutate] of broken) assert.throws(() => parseVerdict(mutate(structuredClone(good))), ReviewFailed, name);
});

test("reviewClient: posts the question as data with the key, and reads the verdict", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const review = reviewClient({ apiKey: "k-test", model: "jev-test", fetch: async (url, init) => (calls.push({ url: String(url), init: init! }), json(jevAnswer("APPROVE"))) });
  assert.deepEqual(await review("Will he hit 100 viewers?"), { approved: true });
  assert.equal(calls[0].url, TYPESAFE_URL);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer k-test");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "jev-test");
  assert.equal(body.state.question, "Will he hit 100 viewers?");
  assert.deepEqual(Object.keys(body.questions.verdict.criteria), ["APPROVE", "REJECT"]);
  assert.deepEqual(Object.keys(body.questions.reason.criteria), REASON_IDS);
  assert.match(body.questions.verdict.instructions.rules, /untrusted data/);
});

test("reviewClient: retries 429/503/529 twice, then fails; other errors fail at once", async () => {
  let n = 0;
  const busyThenOk = reviewClient({ apiKey: "k", sleep: noSleep, fetch: async () => (++n < 3 ? json({}, [429, 529][n - 1]) : json(jevAnswer("REJECT"))) });
  assert.deepEqual(await busyThenOk("Will it rain?"), { approved: false, reason: "SPAM", text: "Not approved: spam or ads" });
  assert.equal(n, 3);
  n = 0;
  const alwaysBusy = reviewClient({ apiKey: "k", sleep: noSleep, fetch: async () => (n++, json({}, 503)) });
  await assert.rejects(alwaysBusy("Will it rain?"), /HTTP 503/);
  assert.equal(n, 3);
  n = 0;
  const denied = reviewClient({ apiKey: "k", sleep: noSleep, fetch: async () => (n++, json({ error: "secret detail" }, 401)) });
  await assert.rejects(denied("Will it rain?"), (e: Error) => e instanceof ReviewFailed && e.message === "Review answered HTTP 401");
  assert.equal(n, 1);
});

test("reviewClient: no key, a dropped connection or a timeout is a failure", async () => {
  let called = false;
  await assert.rejects(reviewClient({ apiKey: undefined, fetch: async () => ((called = true), json({})) })("Will it rain?"), /not set up/);
  assert.equal(called, false);
  await assert.rejects(reviewClient({ apiKey: "k", fetch: async () => Promise.reject(new TypeError("fetch failed")) })("Will it rain?"), /connection failed/);
  const hang: typeof fetch = (_url, init) =>
    new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  await assert.rejects(reviewClient({ apiKey: "k", fetch: hang, timeoutMs: 20 })("Will it rain?"), /timed out/);
});
