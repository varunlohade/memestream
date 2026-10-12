/** Our own test coins stay off the public lists (home, tape, /api/coins) but still open by link. */
import { isBase58Of } from "./base58";

/** The creator wallets in a comma list (MEMESTREAM_HIDDEN_CREATORS); entries that aren't addresses are ignored. */
export function hiddenCreators(list: string | undefined): Set<string> {
  return new Set(
    (list ?? "")
      .split(",")
      .map((w) => w.trim())
      .filter((w) => isBase58Of(w, 32)),
  );
}

/** Single coins kept off the public lists by mint address (MEMESTREAM_HIDDEN_MINTS, a comma list). */
export function hiddenMints(list: string | undefined): Set<string> {
  return hiddenCreators(list);
}

export function withoutHiddenCreators<T extends { creator: string; mint?: string }>(coins: T[], hidden: Set<string>, mints: Set<string> = new Set()): T[] {
  if (hidden.size === 0 && mints.size === 0) return coins;
  return coins.filter((coin) => !hidden.has(coin.creator) && !(coin.mint && mints.has(coin.mint)));
}
