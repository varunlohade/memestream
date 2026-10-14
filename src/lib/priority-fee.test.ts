import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  builderUnitLimit,
  computeUnitLimit,
  HARD_MAX_MICRO_LAMPORTS,
  DEFAULT_PRIORITY_FEE,
  MAX_COMPUTE_UNITS,
  maxPriorityFeeLamports,
  pickMicroLamports,
  priorityFeeSettings,
  setComputeBudget,
  writableAccounts,
} from "./priority-fee";

const settings = DEFAULT_PRIORITY_FEE;

test("the price is the 75th percentile of recent fees", () => {
  const samples = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000];
  assert.equal(pickMicroLamports(samples, settings), 60_000);
  assert.equal(pickMicroLamports([...samples].reverse(), settings), 60_000, "order doesn't matter");
});

test("the price never goes below the floor or above the cap", () => {
  assert.equal(pickMicroLamports([], settings), settings.minMicroLamports, "no samples: the floor");
  assert.equal(pickMicroLamports([0, 0, 0], settings), settings.minMicroLamports);
  assert.equal(pickMicroLamports([50_000_000, 90_000_000], settings), settings.maxMicroLamports, "a fee spike is capped");
  assert.equal(pickMicroLamports([Number.NaN, -5], settings), settings.minMicroLamports, "junk is ignored");
});

test("the cap comes from env; a bad value keeps the safe default", () => {
  assert.equal(priorityFeeSettings("250000").maxMicroLamports, 250_000);
  assert.equal(priorityFeeSettings("5000").minMicroLamports, 5_000, "the floor never exceeds the cap");
  for (const bad of [undefined, "", "abc", "-1", "0", "1.5"]) assert.equal(priorityFeeSettings(bad), DEFAULT_PRIORITY_FEE, String(bad));
});

test("the unit limit is the simulated use plus a margin, or the fallback, never above the runtime limit", () => {
  assert.equal(computeUnitLimit(100_000, settings), 130_000);
  assert.equal(computeUnitLimit(undefined, settings), settings.fallbackUnits);
  assert.equal(computeUnitLimit(0, settings), settings.fallbackUnits);
  assert.equal(computeUnitLimit(1_300_000, settings), MAX_COMPUTE_UNITS);
});

test("the budget goes first, once, replacing any the builder added", () => {
  const [payer, to] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const tx = new Transaction({ feePayer: payer, recentBlockhash: "11111111111111111111111111111111" }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 999 }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports: 1 }),
  );
  setComputeBudget(tx, 50_000, 20_000);
  setComputeBudget(tx, 60_000, 30_000);
  const budget = tx.instructions.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
  assert.equal(budget.length, 2);
  assert.equal(tx.instructions.length, 3);
  assert.ok(tx.instructions[2].programId.equals(SystemProgram.programId), "the transfer is kept, last");
  assert.equal(tx.instructions[0].data.readUInt32LE(1), 60_000, "unit limit");
  assert.equal(Number(tx.instructions[1].data.readBigUInt64LE(1)), 30_000, "unit price");
  assert.deepEqual(writableAccounts(tx).map(String).sort(), [payer, to].map(String).sort());
});

test("the env cap is clamped to a hard ceiling", () => {
  assert.equal(priorityFeeSettings("999999999").maxMicroLamports, HARD_MAX_MICRO_LAMPORTS);
  assert.equal(priorityFeeSettings(String(HARD_MAX_MICRO_LAMPORTS)).maxMicroLamports, HARD_MAX_MICRO_LAMPORTS);
  assert.equal(pickMicroLamports([1e12], priorityFeeSettings("999999999")), HARD_MAX_MICRO_LAMPORTS);
});

test("without a simulation, the builder's own larger unit limit wins over the fallback (migrateToDammV2's 600k)", () => {
  const payer = Keypair.generate().publicKey;
  const tx = new Transaction({ feePayer: payer, recentBlockhash: "11111111111111111111111111111111" }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 7 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  );
  assert.equal(builderUnitLimit(tx), 600_000, "the price instruction is ignored");
  assert.equal(computeUnitLimit(undefined, settings, builderUnitLimit(tx)), 600_000);
  assert.equal(computeUnitLimit(undefined, settings, 100_000), settings.fallbackUnits, "a smaller builder limit keeps the fallback");
  assert.equal(computeUnitLimit(50_000, settings, 600_000), 70_000, "a simulation still decides when it ran");
  assert.equal(builderUnitLimit(new Transaction()), 0);
});

test("the most a transaction pays in priority fee", () => {
  assert.equal(maxPriorityFeeLamports({ units: 400_000, microLamports: 1_000_000 }), 400_000);
  assert.equal(maxPriorityFeeLamports({ units: 1, microLamports: 1 }), 1, "rounds up");
});
