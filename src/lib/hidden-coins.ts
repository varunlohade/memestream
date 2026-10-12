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

export function withoutHiddenCreators<T extends { creator: string }>(coins: T[], hidden: Set<string>): T[] {
  return hidden.size === 0 ? coins : coins.filter((coin) => !hidden.has(coin.creator));
}
