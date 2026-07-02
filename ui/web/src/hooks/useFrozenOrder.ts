import { useMemo } from "react";

// Frozen row order: recomputed ONLY when `resortKey` changes — the resortKey
// encodes the sort (key/dir), the search, and the SET of ids, but NOT any row's
// values. This keeps rows from jumping/reordering on live value updates; values
// still refresh in place. A manual sort re-sorts because it changes resortKey.
//
// Returns the ordered items: previously-known ids in frozen order, then any
// brand-new id appended.
export function useFrozenOrder<T>(
  items: T[],
  idOf: (item: T) => string,
  resortKey: string,
  sorter: (a: T, b: T) => number,
): T[] {
  const order = useMemo(() => {
    return [...items].sort(sorter).map(idOf);
    // resortKey is the intentional dependency; items/sorter/idOf are read at that
    // moment but must not retrigger on value-only changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resortKey]);

  return useMemo(() => {
    const byId = new Map(items.map((s) => [idOf(s), s] as const));
    const ordered = order.map((id) => byId.get(id)).filter(Boolean) as T[];
    const known = new Set(order);
    for (const s of items) if (!known.has(idOf(s))) ordered.push(s);
    return ordered;
  }, [items, order, idOf]);
}
