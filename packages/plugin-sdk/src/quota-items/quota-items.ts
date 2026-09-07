import type { OAuthQuotaItem } from '../oauth';

// Reserve every emitted id, including generated suffixes, to keep quota snapshots valid.
export function dedupeQuotaItemIds(items: readonly OAuthQuotaItem[], separator = '-'): readonly OAuthQuotaItem[] {
  const taken = new Set<string>();
  return items.map((item) => {
    if (!taken.has(item.id)) {
      taken.add(item.id);
      return item;
    }
    let count = 2;
    while (taken.has(`${item.id}${separator}${count}`)) count += 1;
    const id = `${item.id}${separator}${count}`;
    taken.add(id);
    return { ...item, id };
  });
}
