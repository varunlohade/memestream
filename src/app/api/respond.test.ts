import assert from "node:assert/strict";
import { test } from "node:test";
import { BusyError, UserError } from "@/server/errors";
import { fail, failOrBusy, jsonBody, jsonError } from "./respond";

const answer = async (response: Response) => [response.status, await response.json()];

test("a refusal is a status with an { error } body", async () => {
  assert.deepEqual(await answer(jsonError("Coin not found", 404)), [404, { error: "Coin not found" }]);
});

test("user errors show their message; anything else is a generic 500", async () => {
  const error = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await answer(fail(new UserError("Missing mint"))), [400, { error: "Missing mint" }]);
    assert.deepEqual(await answer(fail(new Error("RPC key leaked in here"))), [500, { error: "Something went wrong. Try again." }]);
  } finally {
    console.error = error;
  }
});

test("a spent RPC budget answers busy; other errors fall through to fail", async () => {
  assert.deepEqual(await answer(failOrBusy(new BusyError())), [503, { error: "Busy, try again" }]);
  assert.deepEqual(await answer(failOrBusy(new UserError("Missing mint"))), [400, { error: "Missing mint" }]);
});

test("only a JSON object body is read; anything else is empty", async () => {
  const post = (body: string) => new Request("http://x/", { method: "POST", body });
  assert.deepEqual(await jsonBody(post('{"wallet":"W"}')), { wallet: "W" });
  for (const body of ["[1,2]", "not json", "null", "\"text\""]) assert.deepEqual(await jsonBody(post(body)), {}, body);
});

test("an RPC rate limit (429 from the provider) answers busy (503), not a generic 500", async () => {
  const rpc429 = new Error('429 Too Many Requests:  {"jsonrpc":"2.0","error":{"code": 429, "message":"Connection rate limits exceeded"}}');
  assert.deepEqual(await answer(fail(rpc429)), [503, { error: "Busy, try again" }]);
  assert.deepEqual(await answer(failOrBusy(rpc429)), [503, { error: "Busy, try again" }]);
});
