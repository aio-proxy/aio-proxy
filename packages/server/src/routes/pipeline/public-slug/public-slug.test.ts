import { expect, test } from 'bun:test';

import { publicSlug } from './public-slug';

test('strips the provider prefix only for provider-qualified selections', () => {
  const qualified = { provider: { id: 'cheap' }, selectionSource: 'provider_qualified' as const };
  expect(publicSlug('cheap/pub', qualified)).toBe('pub');
  const weighted = { provider: { id: 'cheap' }, selectionSource: 'weighted_random' as const };
  expect(publicSlug('cheap/pub', weighted)).toBe('cheap/pub');
});
