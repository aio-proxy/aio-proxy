import { expect, test } from '@rstest/core';

import { routingSearchSchema, withRoutingFilters } from './routing-search';

test('defaults to no filters and a 24h window', () => {
  expect(routingSearchSchema.parse({})).toEqual({ range: '24h' });
});

test('drops an unparseable filter instead of failing the whole page', () => {
  // A hand-edited or stale URL must degrade to "no filter", never throw: throwing here
  // would blank the route rather than showing an unfiltered list.
  expect(routingSearchSchema.parse({ lab: '', range: '90d' })).toEqual({ range: '24h' });
});

test('keeps a valid lab and range', () => {
  expect(routingSearchSchema.parse({ lab: 'anthropic', range: '7d' })).toEqual({
    lab: 'anthropic',
    range: '7d',
  });
});

test('patching a filter leaves the others alone and clears with undefined', () => {
  const base = routingSearchSchema.parse({ lab: 'openai', range: '7d' });
  const cleared = withRoutingFilters(base, { lab: undefined });

  // A cleared filter must be an ABSENT key, not a present key holding undefined: the router's
  // `stripSearchParams` only keeps it out of the URL when the key is gone. `toStrictEqual` fails
  // on a leftover undefined property where `toEqual` would not, and the key check states the
  // same constraint directly without depending on key order.
  expect(cleared).toStrictEqual({ range: '7d' });
  expect(Object.keys(cleared)).not.toContain('lab');
  expect(withRoutingFilters(base, { lab: 'google' }).range).toBe('7d');
});
