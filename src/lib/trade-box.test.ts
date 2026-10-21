import assert from "node:assert/strict";
import { test } from "node:test";
import { amountKey, coinsToSol, convertTyped, freshFloor, QUOTE_REFRESH_MS, quoteUrl, slippageLabel, solToCoins, tradeAmount, tradeChips, unitKey } from "./trade-box";

const PRICE = 3e-8; // SOL per coin

test("coins and SOL convert at the price, rounded to each token's decimals", () => {
  assert.equal(coinsToSol("1000000", PRICE), "0.03");
  assert.equal(coinsToSol("1000000", PRICE, "up"), "0.03");
  assert.equal(solToCoins("0.03", PRICE), "1000000");
  assert.equal(solToCoins("0.1", 3e-7), "333333.333333");
  assert.equal(solToCoins("0.1", 3e-7, "up"), "333333.333334");
  assert.equal(coinsToSol("1", 1e-12), "");
  assert.equal(coinsToSol("1", 1e-12, "up"), "0.000000001");
});

test("conversion of nothing, junk or a missing price is empty", () => {
  assert.equal(coinsToSol("", PRICE), "");
  assert.equal(coinsToSol("0", PRICE), "");
  assert.equal(coinsToSol("1.2.3", PRICE), "");
  assert.equal(solToCoins("1", 0), "");
  assert.equal(solToCoins("1", Number.NaN), "");
});

test("the trade sends SOL on a buy and coins on a sell", () => {
  assert.equal(tradeAmount("buy", "sol", "0.5", PRICE, null), "0.5");
  assert.equal(tradeAmount("sell", "coin", "1000", PRICE, "500"), "1000"); // natural unit: sent as typed, as before
  assert.equal(tradeAmount("buy", "coin", "1000000", PRICE, null), "0.03");
});

test("a sell typed in SOL rounds coins up and caps at holdings", () => {
  assert.equal(tradeAmount("sell", "sol", "0.03", PRICE, "5000000"), "1000000");
  assert.equal(tradeAmount("sell", "sol", "1", PRICE, "5000000"), "5000000");
  assert.equal(tradeAmount("sell", "sol", "0.1", 3e-7, null), "333333.333334");
  assert.equal(tradeAmount("sell", "sol", "", PRICE, "5000000"), "");
});

test("flipping the unit converts the typed amount", () => {
  assert.equal(convertTyped("0.03", "sol", PRICE), "1000000");
  assert.equal(convertTyped("1000000", "coin", PRICE), "0.03");
  assert.equal(convertTyped(" ", "sol", PRICE), "");
});

const labels = (chips: { label: string }[]) => chips.map((c) => c.label);

test("buy chips in SOL: reset, fixed amounts, max keeps the SOL reserve", () => {
  const chips = tradeChips("buy", "sol", { sol: "2.5", coins: "0" }, PRICE);
  assert.deepEqual(labels(chips), ["reset", "0.1", "0.5", "1", "max"]);
  assert.equal(chips[0].amount, "");
  assert.equal(chips[4].amount, "2.49");
  assert.equal(tradeChips("buy", "sol", { sol: "0.005", coins: "0" }, PRICE)[4].amount, "0");
  assert.equal(tradeChips("buy", "sol", null, PRICE)[4].amount, null);
});

test("buy chips in coins: reset plus fixed coin amounts", () => {
  const chips = tradeChips("buy", "coin", null, PRICE);
  assert.deepEqual(labels(chips), ["reset", "1M", "10M", "50M"]);
  assert.equal(chips[1].amount, "1000000");
});

test("sell chips are shares of holdings, in coins or their SOL value", () => {
  const held = { sol: "1", coins: "10000001" };
  const coins = tradeChips("sell", "coin", held, PRICE);
  assert.deepEqual(labels(coins), ["reset", "25%", "50%", "75%", "100%"]);
  assert.deepEqual(
    coins.map((c) => c.amount),
    ["", "2500000.25", "5000000.5", "7500000.75", "10000001"],
  );
  const sol = tradeChips("sell", "sol", held, PRICE);
  assert.equal(sol[4].amount, "0.30000003");
  // 100% in SOL sends exactly what's held, never more.
  assert.equal(tradeAmount("sell", "sol", sol[4].amount ?? "", PRICE, held.coins), "10000001");
  assert.equal(tradeChips("sell", "coin", null, PRICE)[1].amount, null);
  assert.equal(tradeChips("sell", "sol", { sol: "1", coins: "0" }, PRICE)[4].amount, "0");
});

test("100% in SOL sells exactly the holdings across awkward prices", () => {
  for (const [coins, price] of [["12345678.123457", 3.3e-8], ["1.000001", 0.0123], ["987654321", 7.1e-9], ["0.000001", 2.9e-8]] as const) {
    const all = tradeChips("sell", "sol", { sol: "0", coins }, price)[4].amount ?? "";
    assert.equal(tradeAmount("sell", "sol", all, price, coins), coins, `${coins} at ${price}`);
  }
});

test("slippage labels", () => {
  assert.deepEqual([50, 100, 300, 500].map(slippageLabel), ["0.5%", "1%", "3%", "5%"]);
});

test("freshFloor: sends the minimum shown while the fresh expected amount is above it; holds the trade at or past the slippage", () => {
  // Shown: expect 1010 coins, at least 1000 with 1% slippage.
  assert.deepEqual(freshFloor("buy", "1000", "1005"), { floor: "1000" }, "another buyer moved the price a little: still within the slippage, the floor shown");
  assert.deepEqual(freshFloor("buy", "1000", "1000.000001"), { floor: "1000" }, "just above the line: trades");
  assert.deepEqual(freshFloor("buy", "1000", "1000"), { moved: true }, "exactly at the line: no room left, show the new quote");
  assert.deepEqual(freshFloor("buy", "1000", "999.999999"), { moved: true }, "past it: show the new quote");
  assert.deepEqual(freshFloor("buy", "1000", "1020"), { floor: "1000" }, "better: the floor stays what the user agreed to");
  assert.deepEqual(freshFloor("sell", "0.123456789", "0.123456788"), { moved: true }, "SOL compares to the lamport");
  assert.deepEqual(freshFloor("sell", "0.1", "0.10"), { moved: true }, "the same amount, written differently: at the line");
  assert.deepEqual(freshFloor("sell", "0.1", "0.100000001"), { floor: "0.1" }, "one lamport above: trades");
  assert.deepEqual(freshFloor("sell", null, "0.2"), { moved: true }, "nothing was shown: show it first");
  assert.deepEqual(freshFloor("sell", "0.2", "abc"), { moved: true });
});

test("quoteUrl and the refresh interval", () => {
  assert.equal(quoteUrl("Mint1", "sell", "5", 100), "/api/quote?mint=Mint1&side=sell&amount=5&slippageBps=100");
  assert.equal(QUOTE_REFRESH_MS, 10_000);
});

test("saved amounts: a versioned key per coin and side, so an amount saved before units were kept is ignored", () => {
  assert.equal(amountKey("Mint1", "sell"), "memestream.amount2.Mint1.sell");
  assert.notEqual(amountKey("Mint1", "sell"), "memestream.amount.Mint1.sell", "the old key is never read");
  assert.equal(unitKey("Mint1", "sell"), "memestream.unit.Mint1.sell");
  assert.notEqual(amountKey("Mint1", "buy"), amountKey("Mint2", "buy"));
});
