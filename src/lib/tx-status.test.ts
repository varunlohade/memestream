import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTxError } from "./tx-status";

test("a slippage failure reads as a price move; other errors stay raw", () => {
  assert.match(describeTxError({ InstructionError: [2, { Custom: 6002 }] }), /price moved/);
  assert.equal(describeTxError({ InstructionError: [0, { Custom: 1 }] }), '{"InstructionError":[0,{"Custom":1}]}');
  assert.equal(describeTxError("AccountInUse"), '"AccountInUse"');
});
