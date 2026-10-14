import assert from "node:assert/strict";
import { test } from "node:test";
import { BET_WINDOWS_MIN } from "@/lib/predictions/rules";
import { jevAnswer, REASON_IDS, STREAM_QUESTIONS, WINDOW_IDS } from "./jev-fake";
import { APPROVE_MIN_CONFIDENCE, parseVerdict, requestBody, ReviewBudgetSpent, ReviewFailed, reviewClient, TYPESAFE_URL } from "./review";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

test("parseVerdict: APPROVE at enough confidence approves; low confidence or REJECT does not", () => {
  assert.deepEqual(parseVerdict(jevAnswer("APPROVE", 0.95)), { approved: true, windowMin: null });
  assert.deepEqual(parseVerdict(jevAnswer("APPROVE", APPROVE_MIN_CONFIDENCE)), { approved: true, windowMin: null });
  assert.deepEqual(parseVerdict(jevAnswer("APPROVE", 0.55, "NOT_YES_NO")), { approved: false, reason: "NOT_YES_NO", text: "Your question wasn't approved: not a clear yes/no question." });
  assert.deepEqual(parseVerdict(jevAnswer("REJECT", 0.9, "HATE")), { approved: false, reason: "HATE", text: "Your question wasn't approved: hateful." });
});

test("parseVerdict: APPROVE needs a high APPROVE probability and an OK reason, not just a stated confidence", () => {
  const coinFlip = jevAnswer("APPROVE", 0.99);
  coinFlip.answers.verdict.probabilities = { APPROVE: 0.5, REJECT: 0.5 };
  assert.equal(parseVerdict(coinFlip).approved, false, "0.5/0.5 with confidence 0.99 does not approve");
  assert.deepEqual(parseVerdict(jevAnswer("APPROVE", 0.95, "HATE")), { approved: false, reason: "HATE", text: "Your question wasn't approved: hateful." });
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

test("parseVerdict: the AI's betting window, checked strictly; unsure or malformed means none, never a rejection", () => {
  for (const [id, minutes] of WINDOW_IDS.map((id, i) => [id, BET_WINDOWS_MIN[i]] as const)) {
    assert.deepEqual(parseVerdict(jevAnswer("APPROVE", 0.9, "OK", { choice: id })), { approved: true, windowMin: minutes }, id);
  }
  assert.deepEqual(parseVerdict(jevAnswer("APPROVE", 0.9, "OK", { choice: "W5", confidence: APPROVE_MIN_CONFIDENCE - 0.01 })), { approved: true, windowMin: null }, "low confidence");
  const good = jevAnswer("APPROVE", 0.9, "OK", { choice: "W5" });
  const broken: [string, (w: (typeof good.answers)["window"]) => unknown][] = [
    ["unknown id", (w) => ({ ...w, choice: "W3" })],
    ["missing id", (w) => ({ ...w, probabilities: { W5: 1 } })],
    ["sum off", (w) => ({ ...w, probabilities: { ...w!.probabilities, W1: 0.5 } })],
    ["choice not the top", (w) => ({ ...w, choice: "W1" })],
    ["string confidence", (w) => ({ ...w, confidence: "0.9" })],
    ["not an object", () => "W5"],
  ];
  for (const [name, mutate] of broken) {
    const answer = structuredClone(good);
    assert.deepEqual(parseVerdict({ answers: { ...answer.answers, window: mutate(answer.answers.window) } }), { approved: true, windowMin: null }, name);
  }
  assert.equal(parseVerdict(jevAnswer("REJECT", 0.9, "SPAM", { choice: "W5" })).approved, false, "a window never approves a question");
});

test("criteria wording: real stream questions are data only, and the APPROVE/REJECT text covers them", () => {
  const body = requestBody(STREAM_QUESTIONS[0][0], "jev-test");
  const criteriaText = JSON.stringify(body.questions);
  const { APPROVE, REJECT } = body.questions.verdict.criteria;
  const reasons = body.questions.reason.criteria;
  // Questions about the streamer, a round, a trip or chat are named as fine...
  for (const word of ["streamer", "he/she", "round", "trip", "chat"]) assert.ok(APPROVE.includes(word), `APPROVE mentions ${word}`);
  // ...and the strict reasons leave the streamer out: "he" or "she" is never a private person.
  assert.match(reasons.PRIVATE_PERSON, /not the streamer/);
  assert.match(REJECT, /other than the streamer/);
  assert.match(reasons.NOT_YES_NO, /about the streamer, the game or chat .* is fine/);
  assert.doesNotMatch(REJECT, /resolvable/, "REJECT doesn't refuse a question just for being hard to settle");
  for (const [question, window] of STREAM_QUESTIONS) {
    const asked = requestBody(question, "jev-test");
    assert.equal(asked.state.question, question);
    assert.ok(!criteriaText.includes(question), `"${question}" stays out of the criteria`);
    assert.ok(window in asked.questions.window.criteria, `${window} is a window id`);
  }
});

test("reviewClient: posts the question as data with the key, and reads the verdict", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const review = reviewClient({ apiKey: "k-test", model: "jev-test", fetch: async (url, init) => (calls.push({ url: String(url), init: init! }), json(jevAnswer("APPROVE"))) });
  assert.deepEqual(await review("Will he hit 100 viewers?"), { approved: true, windowMin: null });
  assert.equal(calls[0].url, TYPESAFE_URL);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer k-test");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "jev-test");
  assert.equal(body.state.question, "Will he hit 100 viewers?");
  assert.deepEqual(Object.keys(body.questions.verdict.criteria), ["APPROVE", "REJECT"]);
  assert.deepEqual(Object.keys(body.questions.reason.criteria), REASON_IDS);
  assert.deepEqual(Object.keys(body.questions.window.criteria), WINDOW_IDS, "the window is one more question in the same request");
  assert.match(body.questions.window.instructions.rules, /untrusted data/);
  assert.match(body.questions.verdict.instructions.rules, /untrusted data/);
});

test("reviewClient: retries 429/503/529 twice, then fails; other errors fail at once", async () => {
  let n = 0;
  const busyThenOk = reviewClient({ apiKey: "k", sleep: noSleep, fetch: async () => (++n < 3 ? json({}, [429, 529][n - 1]) : json(jevAnswer("REJECT"))) });
  assert.deepEqual(await busyThenOk("Will it rain?"), { approved: false, reason: "SPAM", text: "Your question wasn't approved: spam or ads." });
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

test("audit 6: every review attempt takes a call from the daily budget, retries included; spent, nothing is sent", async () => {
  let sent = 0;
  let spent = 0;
  const busyThenOk = reviewClient({ apiKey: "k", sleep: async () => {}, fetch: async () => (++sent < 3 ? new Response("{}", { status: 429 }) : Response.json(jevAnswer("APPROVE"))) });
  await busyThenOk("Will he jump?", async () => (spent++, true));
  assert.deepEqual([sent, spent], [3, 3]);
  sent = 0;
  await assert.rejects(busyThenOk("Will he jump?", async () => false), (e: Error) => e instanceof ReviewBudgetSpent);
  assert.equal(sent, 0);
});
