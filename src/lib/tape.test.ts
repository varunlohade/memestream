import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinView, TradeView } from "./api-types";
import { buildTape, TAPE_MAX_TRADES } from "./tape";

const NOW = 1_800_000_000;
const coin = (mint: string, symbol: string, status: CoinView["status"] = "trading", progress = 0.5) =>
  ({ mint, symbol, status, progress }) as CoinView;
const trade = (signature: string, time: number | null, side: "buy" | "sell" = "buy"): TradeView =>
  ({ signature, side, sol: "0.5", coins: "1", wallet: "7xKp3fWallet", time, priceSol: 1, byStreamer: false });

test("no coins: empty tape (the strip hides)", () => {
  assert.deepEqual(buildTape([], new Map(), NOW), []);
});

test("busy: newest trades first, no race filler", () => {
  const trades = Array.from({ length: 6 }, (_, i) => trade(`s${i}`, NOW - i * 60));
  const tape = buildTape([coin("m", "LOFI")], new Map([["m", trades]]), NOW);
  assert.deepEqual(tape.map((t) => t.kind), Array(6).fill("trade"));
  assert.equal(tape[0].kind === "trade" && tape[0].time, NOW);
  assert.equal(tape[0].kind === "trade" && tape[0].symbol, "LOFI");
});

test("quiet (fewer than 5 recent trades): race items fill in, most progress first", () => {
  const coins = [coin("a", "AAA", "trading", 0.2), coin("b", "BBB", "trading", 0.9), coin("g", "GRAD", "graduated", 1)];
  const tape = buildTape(coins, new Map([["a", [trade("old", NOW - 3 * 3600)]]]), NOW);
  assert.deepEqual(tape.map((t) => `${t.kind}:${t.symbol}`), ["graduated:GRAD", "trade:AAA", "race:BBB", "race:AAA"]);
});

test("trades are capped, deduplicated, and only for coins the list shows", () => {
  const many = Array.from({ length: 30 }, (_, i) => trade(`s${i}`, NOW - i));
  const tape = buildTape([coin("m", "M")], new Map([["m", [...many, many[0]]], ["hidden", [trade("x", NOW)]]]), NOW);
  assert.equal(tape.filter((t) => t.kind === "trade").length, TAPE_MAX_TRADES);
  assert.ok(!tape.some((t) => t.mint === "hidden"));
});
