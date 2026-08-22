import { expect, test } from 'bun:test';

import { routingNumberView } from './number-view';

test('reports authored and effective routing values without rewriting raw config', () => {
  expect(routingNumberView(1.6, 2)).toEqual({ authored: 1.6, effective: 2, wasNormalized: true });
  expect(routingNumberView(undefined, 1)).toEqual({ effective: 1, wasNormalized: false });
});
