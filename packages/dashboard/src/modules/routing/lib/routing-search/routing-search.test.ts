import { expect, test } from '@rstest/core';

import { routingSearchSchema, toggleRoutingRisk, withRoutingFilters } from './routing-search';

test('defaults to no filters and a 24h window', () => {
  expect(routingSearchSchema.parse({})).toEqual({ range: '24h' });
});

test('drops an unparseable filter instead of failing the whole page', () => {
  // A hand-edited or stale URL must degrade to "no filter", never throw: throwing here
  // would blank the route rather than showing an unfiltered list.
  expect(routingSearchSchema.parse({ risk: 'not-a-risk', lab: '', range: '90d' })).toEqual({ range: '24h' });
});

test('keeps a valid risk, lab and range', () => {
  expect(routingSearchSchema.parse({ risk: 'no-eligible', lab: 'anthropic', range: '7d' })).toEqual({
    risk: 'no-eligible',
    lab: 'anthropic',
    range: '7d',
  });
});

test('toggling the active risk clears it and switching risks replaces it', () => {
  const base = routingSearchSchema.parse({ risk: 'no-eligible' });

  expect(toggleRoutingRisk(base, 'no-eligible').risk).toBeUndefined();
  expect(toggleRoutingRisk(base, 'single-point').risk).toBe('single-point');
});

test('patching a filter leaves the others alone and clears with undefined', () => {
  const base = routingSearchSchema.parse({ risk: 'deviating', lab: 'openai', range: '7d' });
  const cleared = withRoutingFilters(base, { lab: undefined });

  // A cleared filter must be an ABSENT key, not a present key holding undefined: the router's
  // `stripSearchParams` only keeps it out of the URL when the key is gone. `toStrictEqual` fails
  // on a leftover undefined property where `toEqual` would not, and the key check states the
  // same constraint directly without depending on key order.
  expect(cleared).toStrictEqual({ risk: 'deviating', range: '7d' });
  expect(Object.keys(cleared)).not.toContain('lab');
  expect(withRoutingFilters(base, { lab: 'google' }).risk).toBe('deviating');
});
