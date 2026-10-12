/**
 * TEST ONLY: runs the store's real Lua scripts in a Lua VM (fengari) against a tiny in-memory
 * stand-in for the few Redis commands they use, so the Redis store runs the same tests as the
 * memory store in `npm test`. fengari is a devDependency.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Redis } from "@upstash/redis";

/* eslint-disable @typescript-eslint/no-explicit-any -- fengari ships no types */
type Fengari = any;

/** fengari (a devDependency); LUA_TEST_DIR may point at another install. Null only if it's missing. */
export function loadFengari(): Fengari | null {
  try {
    return createRequire(join(process.env.LUA_TEST_DIR ?? process.cwd(), "index.js"))("fengari");
  } catch {
    return null;
  }
}

type Reply = null | number | string | { ok: string } | Reply[];

/** The handful of Redis commands the scripts call, with Redis's reply shapes. */
function fakeDb(now: () => number) {
  const strings = new Map<string, { value: string; until: number }>();
  const hashes = new Map<string, Map<string, string>>();
  const zsets = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const expires = new Map<string, number>();
  /** Drops a hash once its PEXPIRE time has passed, as Redis does. */
  const alive = (k: string) => {
    if ((expires.get(k) ?? Infinity) <= now()) {
      hashes.delete(k);
      expires.delete(k);
    }
    return hashes.get(k);
  };
  const hash = (k: string) => alive(k) ?? hashes.set(k, new Map()).get(k)!;
  const zset = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!;
  const live = (k: string) => strings.has(k) && strings.get(k)!.until > now();

  return (name: string, a: string[]): Reply => {
    switch (name.toUpperCase()) {
      case "SET": {
        // Only the form the scripts use: SET key value PX ms.
        if (a[2] !== "PX" || a.length !== 4) throw new Error("unsupported SET");
        strings.set(a[0], { value: a[1], until: now() + Number(a[3]) });
        return { ok: "OK" };
      }
      case "DEL": {
        const existed = live(a[0]) || alive(a[0]) ? 1 : 0;
        strings.delete(a[0]);
        hashes.delete(a[0]);
        expires.delete(a[0]);
        return existed;
      }
      case "EXISTS":
        return live(a[0]) || alive(a[0]) ? 1 : 0;
      case "HGET":
        return alive(a[0])?.get(a[1]) ?? null;
      case "HMGET":
        return a.slice(1).map((field) => alive(a[0])?.get(field) ?? null);
      case "PEXPIRE":
        if (!alive(a[0])) return 0;
        expires.set(a[0], now() + Number(a[1]));
        return 1;
      case "HSET": {
        const h = hash(a[0]);
        for (let i = 1; i < a.length; i += 2) h.set(a[i], a[i + 1]);
        return (a.length - 1) / 2;
      }
      case "HINCRBY": {
        if (!/^-?\d+$/.test(a[2])) throw new Error(`HINCRBY needs an integer, got ${a[2]}`);
        const h = hash(a[0]);
        const value = Number(h.get(a[1]) ?? 0) + Number(a[2]);
        h.set(a[1], String(value));
        return value;
      }
      case "ZINCRBY": {
        const z = zset(a[0]);
        const value = (z.get(a[2]) ?? 0) + Number(a[1]);
        z.set(a[2], value);
        return String(value);
      }
      case "ZREVRANGE": {
        // Redis order: score descending, ties by member descending.
        const sorted = [...(zsets.get(a[0]) ?? [])].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? 1 : -1));
        const stop = Number(a[2]) < 0 ? sorted.length : Number(a[2]) + 1;
        return sorted.slice(Number(a[1]), stop).flatMap(([member, score]) => [member, String(score)]);
      }
      case "SADD": {
        const set = sets.get(a[0]) ?? sets.set(a[0], new Set()).get(a[0])!;
        const had = set.has(a[1]);
        set.add(a[1]);
        return had ? 0 : 1;
      }
      case "SREM":
        return sets.get(a[0])?.delete(a[1]) ? 1 : 0;
      case "SMEMBERS":
        return [...(sets.get(a[0]) ?? [])];
      default:
        throw new Error(`unsupported command ${name}`);
    }
  };
}

/** A stand-in for the Upstash client's `eval`, backed by fengari and the fake commands above. */
export function luaRedis(fengari: Fengari | null, now: () => number = Date.now): Redis {
  if (!fengari) throw new Error("fengari is missing: run npm install (it is a devDependency)");
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  const call = fakeDb(now);

  const pushReply = (L: unknown, reply: Reply) => {
    if (reply === null) lua.lua_pushboolean(L, false);
    // fengari integers are 32-bit; larger values go in as floats (Redis's Lua 5.1 uses doubles anyway).
    else if (typeof reply === "number") (Math.abs(reply) < 2 ** 31 ? lua.lua_pushinteger : lua.lua_pushnumber)(L, reply);
    else if (typeof reply === "string") lua.lua_pushstring(L, to_luastring(reply));
    else if (Array.isArray(reply)) {
      lua.lua_createtable(L, reply.length, 0);
      reply.forEach((r, i) => {
        pushReply(L, r);
        lua.lua_rawseti(L, -2, i + 1);
      });
    } else {
      lua.lua_createtable(L, 0, 1);
      lua.lua_pushstring(L, to_luastring(reply.ok));
      lua.lua_setfield(L, -2, to_luastring("ok"));
    }
  };

  /** Lua reply -> what Upstash returns: false becomes null, tables become arrays (up to the first nil). */
  const toReply = (L: unknown, index: number): unknown => {
    const type = lua.lua_type(L, index);
    if (type === lua.LUA_TNUMBER) return Math.trunc(lua.lua_tonumber(L, index));
    if (type === lua.LUA_TSTRING) return lua.lua_tojsstring(L, index);
    if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index) ? 1 : null;
    if (type === lua.LUA_TTABLE) {
      const out: unknown[] = [];
      for (let i = 1; ; i++) {
        lua.lua_rawgeti(L, index, i);
        if (lua.lua_isnil(L, -1)) {
          lua.lua_pop(L, 1);
          break;
        }
        out.push(toReply(L, lua.lua_gettop(L)));
        lua.lua_pop(L, 1);
      }
      return out;
    }
    return null;
  };

  const pushStrings = (L: unknown, values: string[], name: string) => {
    lua.lua_createtable(L, values.length, 0);
    values.forEach((v, i) => {
      lua.lua_pushstring(L, to_luastring(v));
      lua.lua_rawseti(L, -2, i + 1);
    });
    lua.lua_setglobal(L, to_luastring(name));
  };

  /** Runs a script to completion in one go, like Redis: nothing else runs in between. */
  const evalScript = (script: string, keys: string[], args: string[]) => {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    pushStrings(L, keys, "KEYS");
    pushStrings(L, args.map(String), "ARGV");
    lua.lua_createtable(L, 0, 1);
    lua.lua_pushcfunction(L, (state: unknown) => {
      const n = lua.lua_gettop(state);
      const parts: string[] = [];
      for (let i = 1; i <= n; i++) parts.push(lua.lua_tojsstring(state, i));
      pushReply(state, call(parts[0], parts.slice(1)));
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring("call"));
    lua.lua_setglobal(L, to_luastring("redis"));
    if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(L, -1));
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(L, -1));
    return toReply(L, -1);
  };

  return { eval: async (script: string, keys: string[], args: string[]) => evalScript(script, keys, args) } as unknown as Redis;
}
