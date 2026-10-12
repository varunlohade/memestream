// Every API route that can reach the chain must go through withRpcGuard (per-client limit + RPC budget).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/** Imports that mean a route can make RPC calls. */
const CHAIN_IMPORTS = ["@/server/chain", "@/server/markets", "@/server/coins", "@/server/transactions", "@/server/metadata", "@solana/web3.js", "@meteora-ag/", "@/server/predictions"];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /^route\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

test("every route handler that touches the chain uses withRpcGuard on every exported handler", () => {
  // All of src/app, not just /api: the /<ticker> short link is a route handler too.
  const routes = routeFiles("src/app");
  assert.ok(routes.length >= 9, "found the route handlers (API routes, the holders list and the /<ticker> short link)");
  assert.ok(routes.some((f) => f.endsWith("holders/route.ts")), "found the holders route");
  assert.ok(routes.some((f) => f.endsWith("predictions/live/route.ts")), "found the live predictions route");
  for (const file of routes) {
    const source = readFileSync(file, "utf8");
    if (!CHAIN_IMPORTS.some((name) => source.includes(`from "${name}`))) continue;
    const handlers = [...source.matchAll(/export (async function|const) (GET|POST|PUT|PATCH|DELETE)\b([^\n]*)/g)];
    assert.ok(handlers.length > 0, `${file} exports a handler`);
    for (const [, kind, method, rest] of handlers) {
      assert.ok(kind === "const" && rest.includes("withRpcGuard("), `${file}: ${method} must be wrapped in withRpcGuard`);
    }
  }
});

/** What server-rendered pages and layouts may import from server modules: budgeted readers or config only. */
const PAGE_ALLOWED: Record<string, string[]> = {
  "@/server/coins": ["getCoinDetail", "listCoins"], // both draw the RPC budget and share caches
  "@/server/chain": ["networkInfo", "getChain"], // config only; RPC handles must not be used (checked below)
};
/** Modules a page may never import: they reach the chain without the budget. */
const PAGE_FORBIDDEN = ["@/server/transactions", "@/server/markets", "@/server/metadata", "@solana/web3.js", "@meteora-ag/"];

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "api" ? [] : pageFiles(path);
    return /^(page|layout)\.tsx$/.test(name) ? [path] : [];
  });
}

test("server-rendered pages and layouts reach the chain only through budgeted readers", () => {
  const files = pageFiles("src/app");
  assert.ok(files.some((f) => f.includes("overlay")) && files.some((f) => f.includes("coin")), "found the pages");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const banned of PAGE_FORBIDDEN) assert.ok(!source.includes(`from "${banned}`), `${file} must not import ${banned}`);
    for (const [, names, from] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
      const allowed = PAGE_ALLOWED[from];
      if (!allowed) continue;
      for (const name of names.split(",").map((n) => n.replace(/^type\s+/, "").trim()).filter(Boolean)) {
        assert.ok(allowed.includes(name), `${file}: ${name} from ${from} isn't a budgeted reader`);
      }
    }
    assert.ok(!/getChain\(\)\.(connection|client)/.test(source), `${file} must not use the RPC connection directly`);
  }
});
