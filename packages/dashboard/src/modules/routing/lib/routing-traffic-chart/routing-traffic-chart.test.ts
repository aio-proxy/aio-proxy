import { expect, test } from '@rstest/core';

import { routingTrafficChartRows } from './routing-traffic-chart';

test('a Provider named "bucket" does not overwrite the bucket timestamp', () => {
  const rows = routingTrafficChartRows(
    ['bucket', 'primary'],
    [{ key: '2026-09-19T00:00:00.000Z', values: { bucket: 3n, primary: 5n } }],
  );

  expect(rows).toEqual([{ bucket: '2026-09-19T00:00:00.000Z', s0: 3, s1: 5 }]);
});
