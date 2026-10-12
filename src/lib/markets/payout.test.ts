import assert from "node:assert/strict";
import { test } from "node:test";
import { profitText, resultLine, winPayout } from "./payout";

const position = (yes: string, no: string) => ({ yes, no, sol: "1" });

test("a win pays 1 SOL per share; profit is on the SOL spent", () => {
  // Round 5 on devnet: 0.005 SOL bought 0.009544883 YES.
  const win = winPayout(0.005, 0.009544883);
  assert.equal(win.sol, 0.009544883);
  assert.ok(Math.abs(win.profit - 0.9089766) < 1e-6);
  assert.equal(profitText(win.profit), "+91%");
  assert.equal(profitText(winPayout(1, 0.96).profit), "-4%");
  assert.equal(winPayout(0, 1).profit, 0);
});

test("the result line: winner, loser, refund, nothing held", () => {
  assert.deepEqual(resultLine([1, 0], position("2.5", "0")), { text: "You won 2.5 SOL", redeem: true });
  assert.deepEqual(resultLine([1, 0], position("0", "3")), { text: "Your NO shares pay 0. YES won.", redeem: false });
  assert.deepEqual(resultLine([0, 1], position("3", "0")), { text: "Your YES shares pay 0. NO won.", redeem: false });
  assert.deepEqual(resultLine([0, 1], position("1", "2")), { text: "You won 2 SOL", redeem: true });
  assert.deepEqual(resultLine([1, 1], position("3", "1")), { text: "Refund: 2 SOL (0.5 per share)", redeem: true });
  assert.deepEqual(resultLine([1, 0], position("0", "0")), { text: "You held no shares", redeem: false });
  assert.deepEqual(resultLine([1, 0], null), { text: "You held no shares", redeem: false });
});
