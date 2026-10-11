import assert from "node:assert/strict";
import { test } from "node:test";
import { type Bet, cleanQuestion, holdsEnough, multiplier, type Outcome, payouts } from "./rules";

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const staked = (bets: Bet[]) => bets.reduce((a, b) => a + b.amount, 0);

test("payout: winners split the losing pool pro rata, plus their stake back", () => {
  const bets: Bet[] = [
    { wallet: "a", side: "yes", amount: 100 },
    { wallet: "b", side: "yes", amount: 300 },
    { wallet: "c", side: "no", amount: 400 },
  ];
  const paid = payouts(bets, "yes");
  assert.deepEqual(Object.fromEntries(paid), { a: 200, b: 600, c: 0 });
  assert.equal(total(paid), staked(bets));
});

test("payout: rounding leftovers go to the largest winning stake; points are conserved", () => {
  const bets: Bet[] = [
    { wallet: "x", side: "yes", amount: 10 },
    { wallet: "y", side: "yes", amount: 20 },
    { wallet: "z", side: "yes", amount: 40 },
    { wallet: "n", side: "no", amount: 100 },
  ];
  // Shares: 100*10/70 = 14, 100*20/70 = 28, 100*40/70 = 57 (99 in all); the 1 left goes to z.
  assert.deepEqual(Object.fromEntries(payouts(bets, "yes")), { x: 24, y: 48, z: 98, n: 0 });
});

test("payout: equal largest stakes break the tie by the lower wallet address", () => {
  const bets: Bet[] = [
    { wallet: "b", side: "no", amount: 30 },
    { wallet: "a", side: "no", amount: 30 },
    { wallet: "c", side: "yes", amount: 11 },
  ];
  // 11 * 30/60 = 5 each, 1 left over: "a" gets it.
  assert.deepEqual(Object.fromEntries(payouts(bets, "no")), { a: 36, b: 35, c: 0 });
});

test("payout: points are conserved across many random predictions", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let round = 0; round < 500; round++) {
    const bets: Bet[] = Array.from({ length: 1 + rand(12) }, (_, i) => ({ wallet: `w${i}`, side: rand(2) ? "yes" : "no", amount: 10 + rand(991) }));
    for (const outcome of ["yes", "no", "cancel"] as Outcome[]) {
      const paid = payouts(bets, outcome);
      assert.equal(total(paid), staked(bets), `round ${round} ${outcome}`);
      for (const b of bets) {
        const got = paid.get(b.wallet) ?? -1;
        assert.ok(got >= 0 && Number.isInteger(got));
        if (outcome !== "cancel" && b.side === outcome) assert.ok(got >= b.amount, "a winner never gets less than the stake");
      }
    }
  }
});

test("payout: cancel, or an empty side, refunds every bet", () => {
  const bets: Bet[] = [
    { wallet: "a", side: "no", amount: 50 },
    { wallet: "b", side: "no", amount: 70 },
  ];
  assert.deepEqual(Object.fromEntries(payouts(bets, "yes")), { a: 50, b: 70 });
  assert.deepEqual(Object.fromEntries(payouts(bets, "no")), { a: 50, b: 70 });
  const mixed: Bet[] = [...bets, { wallet: "c", side: "yes", amount: 10 }];
  assert.deepEqual(Object.fromEntries(payouts(mixed, "cancel")), { a: 50, b: 70, c: 10 });
  assert.equal(payouts([], "yes").size, 0);
});

test("multiplier: what a winning point pays now, stake included", () => {
  assert.equal(multiplier("yes", { yes: 100, no: 140 }), 2.4);
  assert.equal(multiplier("no", { yes: 100, no: 140 }), 240 / 140);
  assert.equal(multiplier("yes", { yes: 0, no: 140 }), null);
});

test("questions: trimmed, whitespace collapsed, 5 to 80 characters, plain text, no links", () => {
  assert.deepEqual(cleanQuestion("  Will I   eat\na banana?  "), { ok: true, question: "Will I eat a banana?" });
  assert.equal(cleanQuestion("Hey?").ok, false);
  assert.equal(cleanQuestion("x".repeat(81)).ok, false);
  assert.equal(cleanQuestion("x".repeat(80)).ok, true);
  assert.equal(cleanQuestion(42).ok, false);
  for (const bad of ["Go to https://scam.example now?", "Visit www.free.io today", "Is pump.fun down?", "Will <b>this</b> work?", "nul\u0000byte here"]) {
    assert.equal(cleanQuestion(bad).ok, false, bad);
  }
});

test("questions: NFKC first, then no invisible format characters, before the link checks", () => {
  assert.deepEqual(cleanQuestion("Is pump\uFF0Efun down?"), { ok: false, error: "No links in questions" }, "fullwidth full stop");
  assert.deepEqual(cleanQuestion("Visit \uFF57\uFF57\uFF57.free.io?"), { ok: false, error: "No links in questions" }, "fullwidth www");
  for (const bad of ["Will I win \u202Etoday?", "Is pump\u200B.fun down?", "Will I\u200D win?", "Will \u2066I\u2069 win?", "\uFEFFWill I win?", "Will I win\u00AD?"]) {
    assert.deepEqual(cleanQuestion(bad), { ok: false, error: "Plain text only" }, JSON.stringify(bad));
  }
  assert.deepEqual(cleanQuestion("Will \uFF29 win \uFF11\uFF10 rounds?"), { ok: true, question: "Will I win 10 rounds?" }, "stored normalized");
});

test("holding: at least 1 whole coin, not 1 base unit", () => {
  for (const coins of ["0", "0.000001", "0.999999", null, undefined, "junk"]) assert.equal(holdsEnough(coins), false, String(coins));
  for (const coins of ["1", "1.000000", "1.5", "250000"]) assert.equal(holdsEnough(coins), true, coins);
});
