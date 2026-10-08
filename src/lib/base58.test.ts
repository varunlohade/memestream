import assert from "node:assert/strict";
import { test } from "node:test";
import { isBase58Of } from "./base58";

const ADDRESS = "Ebt5dA6zkvrin1jr4nvGdU5BbEC6BwV5pPVggs3Tcg9B";

test("an address is base58 for 32 bytes, not 64", () => {
  assert.equal(isBase58Of(ADDRESS, 32), true);
  assert.equal(isBase58Of(ADDRESS, 64), false);
});

test("text that isn't base58 is refused without throwing", () => {
  for (const bad of ["", "0OIl", "not base58!", `${ADDRESS}/../x`]) assert.equal(isBase58Of(bad, 32), false, bad);
});
