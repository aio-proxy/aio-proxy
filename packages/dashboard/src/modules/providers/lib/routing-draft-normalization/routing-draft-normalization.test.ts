import { expect, test } from '@rstest/core';

import { routingDraftNormalization } from './routing-draft-normalization';

test('reports the effective number a fractional authored weight will become on Save', () => {
  expect(routingDraftNormalization('weight', 1.6)).toEqual({ authored: 1.6, effective: 2 });
});

test('clears the notice when the current draft already matches the normalized value', () => {
  expect(routingDraftNormalization('weight', 2)).toBeUndefined();
  expect(routingDraftNormalization('priority', 4)).toBeUndefined();
});

test('reports clamped priority and ignores non-integer priority drafts', () => {
  expect(routingDraftNormalization('priority', 20_000)).toEqual({ authored: 20_000, effective: 10_000 });
  expect(routingDraftNormalization('priority', 1.6)).toBeUndefined();
});
