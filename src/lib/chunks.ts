/** Splits a list into pieces of at most `size`, in order (e.g. RPC calls capped at 100 keys). */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
