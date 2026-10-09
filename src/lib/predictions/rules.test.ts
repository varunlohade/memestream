import assert from "node:assert/strict";
import { test } from "node:test";
import { payouts, settlement, type Outcome, type Stake } from "./rules";

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const staked = (stakes: Stake[]) => stakes.reduce((a, s) => a + s.amount, 0);

test("settlement: graduated or graduating before the deadline is YES", () => {
  assert.equal(settlement("graduated", 999, 1_000), "yes");
  assert.equal(settlement("graduating", 0, 1_000), "yes");
});

test("settlement: still trading before the deadline stays open", () => {
  assert.equal(settlement("trading", 999, 1_000), null);
});

test("settlement: still trading once the deadline passes is NO", () => {
  assert.equal(settlement("trading", 5_000, 1_000), "no");
});

test("settlement: at the exact deadline the window has closed", () => {
  assert.equal(settlement("trading", 1_000, 1_000), "no");
  // Graduated, but first seen at the deadline: it may have happened after, so nobody wins.
  assert.equal(settlement("graduated", 1_000, 1_000), "void");
  assert.equal(settlement("graduating", 1_001, 1_000), "void");
});

test("payout: winners split the losers' pool pro rata", () => {
  const stakes: Stake[] = [
    { wallet: "a", side: "yes", amount: 100 },
    { wallet: "b", side: "yes", amount: 300 },
    { wallet: "c", side: "no", amount: 400 },
  ];
  const paid = payouts(stakes, "yes");
  assert.deepEqual(Object.fromEntries(paid), { a: 200, b: 600, c: 0 });
  assert.equal(total(paid), staked(stakes));
});

test("payout: rounding leftovers go to the largest remainders, then lower address; points are conserved", () => {
  const stakes: Stake[] = [
    { wallet: "x", side: "yes", amount: 1 },
    { wallet: "y", side: "yes", amount: 1 },
    { wallet: "z", side: "yes", amount: 1 },
    { wallet: "n", side: "no", amount: 100 },
  ];
  const paid = payouts(stakes, "yes");
  // 100 / 3 = 33 each, 1 left over; equal remainders, so "x" gets it.
  assert.deepEqual(Object.fromEntries(paid), { x: 35, y: 34, z: 34, n: 0 });
  assert.equal(total(paid), 103);
});

test("payout: points are conserved across many random markets", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let round = 0; round < 500; round++) {
    const stakes: Stake[] = Array.from({ length: 1 + rand(12) }, (_, i) => ({
      wallet: `w${i}`,
      side: rand(2) ? "yes" : "no",
      amount: 1 + rand(1_000),
    }));
    for (const outcome of ["yes", "no", "void"] as Outcome[]) {
      const paid = payouts(stakes, outcome);
      assert.equal(total(paid), staked(stakes), `round ${round} ${outcome}`);
      for (const s of stakes) {
        const got = paid.get(s.wallet) ?? -1;
        assert.ok(got >= 0 && Number.isInteger(got));
        if (outcome !== "void" && s.side === outcome) assert.ok(got >= s.amount, "a winner never gets less than the stake");
      }
    }
  }
});

test("payout: one-sided or void markets refund every stake", () => {
  const stakes: Stake[] = [
    { wallet: "a", side: "no", amount: 50 },
    { wallet: "b", side: "no", amount: 70 },
  ];
  assert.deepEqual(Object.fromEntries(payouts(stakes, "yes")), { a: 50, b: 70 });
  assert.deepEqual(Object.fromEntries(payouts(stakes, "no")), { a: 50, b: 70 });
  const mixed: Stake[] = [...stakes, { wallet: "c", side: "yes", amount: 10 }];
  assert.deepEqual(Object.fromEntries(payouts(mixed, "void")), { a: 50, b: 70, c: 10 });
  assert.equal(payouts([], "yes").size, 0);
});
