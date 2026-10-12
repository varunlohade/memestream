import assert from "node:assert/strict";
import { test } from "node:test";
import { hiddenCreators, hiddenMints, withoutHiddenCreators } from "./hidden-coins";

const TEST_CREATOR = "GxzcVEh8CCdUbjLgnb7Y4Rc1NAcge77CvXi2ag1rHeYC";
const OTHER_TEST = "AJqQEwGdYsYiko47aRGs4LDyod7RKrcUZW5qtx6NQsMK";
const STREAMER = "11111111111111111111111111111111";
const coins = [
  { mint: "a", creator: TEST_CREATOR },
  { mint: "b", creator: STREAMER },
  { mint: "c", creator: OTHER_TEST },
];

test("a hidden creator's coins are removed, the rest kept in order", () => {
  const hidden = hiddenCreators(` ${TEST_CREATOR} , ${OTHER_TEST}`);
  assert.deepEqual(withoutHiddenCreators(coins, hidden).map((c) => c.mint), ["b"]);
});

test("unset or empty env hides nothing", () => {
  assert.equal(withoutHiddenCreators(coins, hiddenCreators(undefined)), coins);
  assert.equal(withoutHiddenCreators(coins, hiddenCreators("")), coins);
});

test("junk entries are ignored; valid ones still apply", () => {
  const hidden = hiddenCreators(`not-a-key,,0OIl,${TEST_CREATOR.slice(0, 20)},${TEST_CREATOR}x, ${OTHER_TEST}`);
  assert.deepEqual([...hidden], [OTHER_TEST]);
  assert.deepEqual(withoutHiddenCreators(coins, hidden).map((c) => c.mint), ["a", "b"]);
});

test("a single coin can be hidden by mint, the rest stay", () => {
  const coins = [
    { creator: "2Uw2k8qUTTmdkigbLFZxM8bqKc1F4rwmnXYAeT7M5NAK", mint: "CAoh7Xd6g2e8UiV3WAfVX619ZJX38o9WsnwAr9aYsBta" },
    { creator: "2Uw2k8qUTTmdkigbLFZxM8bqKc1F4rwmnXYAeT7M5NAK", mint: "7KcY7TxsgbHwTjqDzahTarybrMNGYNMNphAoTqaoLHKi" },
  ];
  const kept = withoutHiddenCreators(coins, new Set(), hiddenMints("CAoh7Xd6g2e8UiV3WAfVX619ZJX38o9WsnwAr9aYsBta, junk"));
  assert.deepEqual(kept.map((c) => c.mint), ["7KcY7TxsgbHwTjqDzahTarybrMNGYNMNphAoTqaoLHKi"]);
});
