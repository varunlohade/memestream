/**
 * How a coin's game is stored. With up to MAX_LIVE predictions live at full caps, and their results
 * in their flag windows, a game is too big for one document (each is kept under 256 KB):
 * - each live prediction has its own document in a fixed slot (`coin:<mint>:p:<slot>`); the coin's
 *   document keeps only a short entry per live one;
 * - the per-bettor lists of results still in their flag window sit in RESULT_DOCS documents
 *   (`coin:<mint>:r:<n>`), packed several to a document; the coin's document keeps the rest.
 * A fixed set of keys means a game is always read in one go: 1 + MAX_LIVE + RESULT_DOCS keys.
 *
 * Every commit writes the coin document (its version guards the whole game) plus the other
 * documents that changed: a resolved prediction's document is deleted, its slot free for the next one.
 *
 * Documents saved before several predictions could be live had `live: X` or `live: null` (and,
 * briefly, `live: [X, ...]` inline); they load as `[X]` or `[]` and move into slots on the next save.
 */
import { type FlagWindow, type Game, newGame, type Prediction } from "@/lib/predictions/engine";
import { MAX_LIVE } from "@/lib/predictions/rules";
import type { Commit, Doc, SetChange } from "./store";

export const coinKey = (mint: string) => `coin:${mint}`;
const slotKey = (mint: string, slot: number) => `coin:${mint}:p:${slot}`;
const resultsKey = (mint: string, n: number) => `coin:${mint}:r:${n}`;
/** Documents for flag-window results: enough for every result that can be open at once, at full caps (doc-size.test.ts). */
export const RESULT_DOCS = 2;
/** A results document takes more only when every one is this full (it never refuses a result). */
const RESULTS_DOC_CHARS = 250_000;
/** Every key a coin's game is stored under, in the order `loadGame` takes them. */
export const gameKeys = (mint: string) => [
  coinKey(mint),
  ...Array.from({ length: MAX_LIVE }, (_, slot) => slotKey(mint, slot)),
  ...Array.from({ length: RESULT_DOCS }, (_, n) => resultsKey(mint, n)),
];
export const GAME_KEY_COUNT = 1 + MAX_LIVE + RESULT_DOCS;
/** The live slots alone: each holds one live prediction (with its pools), or nothing. */
export const liveSlotKeys = (mint: string) => Array.from({ length: MAX_LIVE }, (_, slot) => slotKey(mint, slot));

/** The coins with at least one live prediction (a Redis set), kept by every game commit. */
export const LIVE_COINS_KEY = "predictions:live";
/** The index change a commit of `game` makes: the coin is listed while it has a live prediction. */
export const liveIndex = (mint: string, game: Game): SetChange => ({ key: LIVE_COINS_KEY, member: mint, add: game.live.length > 0 });
/**
 * The coins with background work left (a Redis set), kept by every game commit: a live prediction,
 * a result still in its flag window, or an AI check still due. The live sweep visits these, so the
 * referee, checks and results that count move on with nobody watching.
 */
export const WORK_COINS_KEY = "predictions:work";
export const workIndex = (mint: string, game: Game): SetChange => ({
  key: WORK_COINS_KEY,
  member: mint,
  add: game.live.length > 0 || game.resolved.some((p) => p.open !== null || p.check !== undefined),
});

/** A live prediction's entry in the coin document: the slot that holds it, and what a glance needs. */
export type LiveEntry = { id: string; slot: number; text: string; lockAt: number };

/** The game, and how to save a later version of it over the documents it was read from. */
export type StoredGame = { game: Game; save: (next: Game) => Commit["docs"] };

const isEntry = (value: unknown): value is LiveEntry => typeof (value as LiveEntry | null)?.slot === "number";

/** A results document: each open result's per-bettor list, by result id. */
type ResultsDoc = Record<string, FlagWindow["results"]>;

/** `docs`: the documents read at `gameKeys(mint)`. */
export function loadGame(mint: string, docs: Doc[], streamer: string): StoredGame {
  const coinDoc = docs[0];
  const slotDocs = docs.slice(1, 1 + MAX_LIVE);
  const resultDocs = docs.slice(1 + MAX_LIVE, GAME_KEY_COUNT);
  const stored = coinDoc.json ? JSON.parse(coinDoc.json) : {};
  const game: Game = { ...newGame(streamer), ...stored, creator: streamer, live: [] };
  /** Which results document each open result's list was read from. */
  const placed = new Map<string, number>();
  resultDocs.forEach((doc, n) => {
    const lists: ResultsDoc = doc?.json ? JSON.parse(doc.json) : {};
    for (const p of game.resolved) {
      if (p.open && Object.hasOwn(lists, p.id)) {
        p.open = { ...p.open, results: lists[p.id] };
        placed.set(p.id, n);
      }
    }
  });
  /** Which slot each live prediction was read from. */
  const slots = new Map<string, number>();
  const old: unknown[] = Array.isArray(stored.live) ? stored.live : stored.live ? [stored.live] : [];
  for (const item of old) {
    if (!isEntry(item)) {
      game.live.push(item as Prediction);
      continue;
    }
    const json = slotDocs[item.slot]?.json;
    const p: Prediction | null = json ? JSON.parse(json) : null;
    if (p?.id !== item.id) {
      console.warn(`predictions: live prediction ${item.id} on ${mint} has no document in slot ${item.slot}; dropped`);
      continue;
    }
    game.live.push(p);
    slots.set(p.id, item.slot);
  }

  const save = (next: Game): Commit["docs"] => {
    const taken = new Set(next.live.map((p) => slots.get(p.id)));
    const free = Array.from({ length: MAX_LIVE }, (_, slot) => slot).filter((slot) => !taken.has(slot));
    const entries: LiveEntry[] = [];
    const content: (string | null)[] = Array(MAX_LIVE).fill(null);
    for (const p of next.live) {
      const slot = slots.get(p.id) ?? free.shift();
      if (slot === undefined) throw new Error(`predictions: more than ${MAX_LIVE} live predictions`);
      entries.push({ id: p.id, slot, text: p.text, lockAt: p.lockAt });
      content[slot] = JSON.stringify(p);
    }
    // Open results' lists: each stays in its document while it fits; a new one goes to the first with room.
    const open = next.resolved.filter((p) => p.open);
    const used: number[] = Array(RESULT_DOCS).fill(0);
    const home = new Map<string, number>();
    for (const p of [...open.filter((x) => placed.has(x.id)), ...open.filter((x) => !placed.has(x.id))]) {
      const size = JSON.stringify(p.open!.results).length + p.id.length + 4;
      const fits = (i: number) => used[i] + size <= RESULTS_DOC_CHARS;
      const before = placed.get(p.id);
      const room = used.findIndex((_, i) => fits(i));
      const n = before !== undefined && fits(before) ? before : room >= 0 ? room : used.indexOf(Math.min(...used));
      home.set(p.id, n);
      used[n] += size;
    }
    // Filled in the results' own order, so an unchanged game writes the same text again.
    const lists: ResultsDoc[] = Array.from({ length: RESULT_DOCS }, () => ({}));
    for (const p of open) lists[home.get(p.id)!][p.id] = p.open!.results;
    const resolved = next.resolved.map((p) => (p.open ? { ...p, open: { ...p.open, results: {} } } : p));

    const out: Commit["docs"] = [{ key: coinKey(mint), v: coinDoc.v, json: JSON.stringify({ ...next, live: entries, resolved }) }];
    const write = (key: string, before: Doc | undefined, json: string | null) => {
      if (json !== (before?.json ?? null)) out.push({ key, v: before?.v ?? 0, json });
    };
    content.forEach((json, slot) => write(slotKey(mint, slot), slotDocs[slot], json));
    lists.forEach((list, n) => write(resultsKey(mint, n), resultDocs[n], Object.keys(list).length > 0 ? JSON.stringify(list) : null));
    return out;
  };
  return { game, save };
}
