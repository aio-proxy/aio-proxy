import { describe, expect, test } from '@rstest/core';

import { queryKeys } from '@/lib/query-keys';

import { usageQueryOptions } from './usage-service';

describe('usage service', () => {
  test('isolates limited Usage queries from unlimited queries', () => {
    expect(queryKeys.usage('24h', 'requests', 'provider', 5)).not.toEqual(
      queryKeys.usage('24h', 'requests', 'provider', undefined),
    );
    expect(usageQueryOptions({ range: '24h', metric: 'cost', groupBy: 'model', maxResults: 5 }).queryKey).toContain(5);
  });
});
