import { expect, test } from 'bun:test';

import { dedupeQuotaItemIds } from './quota-items';

test.each(['-', '_'])('preserves quota entries through original and generated %s collisions', (separator) => {
  const ids = ['a', 'a', `a${separator}2`, 'a'];
  const items = ids.map((id, index) => ({ id, displayName: `Window ${index}`, remainingRatio: index / 4 }));
  const result = dedupeQuotaItemIds(items, separator);
  expect(result.map((item) => item.id)).toEqual([
    'a',
    `a${separator}2`,
    `a${separator}2${separator}2`,
    `a${separator}3`,
  ]);
  expect(result.map((item, index) => ({ ...item, id: items[index]!.id }))).toEqual(items);
  expect(items.map((item) => item.id)).toEqual(ids);
});

test('uses hyphens by default and skips occupied suffixes', () => {
  expect(dedupeQuotaItemIds(['a', 'a-2', 'a'].map((id) => ({ id, displayName: id }))).map((item) => item.id)).toEqual([
    'a',
    'a-2',
    'a-3',
  ]);
});
