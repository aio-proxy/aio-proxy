import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { render, screen, within } from '@testing-library/react';

import { RoutingModelSummary } from './routing-model-summary';

const model = {
  modelId: 'sonnet',
  providerCount: 2,
  eligibleProviderCount: 2,
  tiers: [
    { priority: 20, providers: [{ providerId: 'primary', weight: 1, share: 1 }] },
    { priority: 10, providers: [{ providerId: 'fallback', weight: 1, share: 1 }] },
  ],
  providers: [],
} as unknown as DashboardRoutingModel;

const totals = (providerId: string, finalCount: bigint) => ({
  providerId,
  finalCount,
  attemptCount: finalCount,
  successCount: finalCount,
  p95LatencyMs: null,
});

test('counts only Providers now in a fallback tier as served by fallback', () => {
  // `removed` served requests in the window but is no longer part of this model. Treating it as a
  // fallback because it is absent from T1 would inflate the count after an ordinary routing edit.
  render(
    <RoutingModelSummary
      model={model}
      totals={[totals('primary', 10n), totals('fallback', 3n), totals('removed', 5n)]}
      known
    />,
  );

  const stat = screen.getByText(m['dashboard.routing.detail.stat_fallback']()).parentElement;
  if (stat === null) throw new Error('fallback stat is missing');
  expect(within(stat).getByText('3')).toBeInTheDocument();
});
