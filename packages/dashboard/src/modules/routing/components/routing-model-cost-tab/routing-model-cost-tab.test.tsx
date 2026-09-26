import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { useRoutingMetadataForm } from '../../hooks/use-routing-metadata-form';
import { RoutingModelCostTab } from './routing-model-cost-tab';

const routingNumber = (effective: number, authored?: number) => ({
  ...(authored === undefined ? {} : { authored }),
  effective,
  wasNormalized: authored !== undefined && authored !== effective,
});

const providerFixture = (id: string, values: Partial<DashboardRoutingProvider> = {}): DashboardRoutingProvider => ({
  kind: ProviderKind.Api,
  enabled: true,
  state: { status: 'ready' },
  defaults: { priority: routingNumber(0), weight: routingNumber(1) },
  effective: {
    priority: 0,
    weight: 1,
    prioritySource: 'provider',
    weightSource: 'provider',
    eligible: true,
    share: 1,
  },
  id,
  ...values,
});

const costModel = (providers: readonly DashboardRoutingProvider[]): DashboardRoutingModel => ({
  modelId: 'cost-tab',
  revision: 'rev-1',
  baselineProviderIds: providers.map((entry) => entry.id),
  providerCount: providers.length,
  eligibleProviderCount: providers.length,
  hasOverrides: false,
  tiers: [
    {
      priority: 0,
      providers: providers.map((entry) => ({ providerId: entry.id, weight: 1, share: 1 / providers.length })),
    },
  ],
  providers: [...providers],
});

const CostHarness: React.FC<{
  readonly providers: readonly DashboardRoutingProvider[];
  readonly writable: boolean;
}> = ({ providers, writable }) => {
  const metadataForm = useRoutingMetadataForm(costModel(providers));
  return <RoutingModelCostTab metadataForm={metadataForm} providers={providers} writable={writable} />;
};

const renderCost = (options: {
  readonly providers: readonly DashboardRoutingProvider[];
  readonly writable?: boolean;
}) => render(<CostHarness providers={options.providers} writable={options.writable ?? true} />);

test('lays providers out as rows rather than stacked blocks', () => {
  renderCost({ providers: [providerFixture('primary'), providerFixture('fallback')] });

  const rows = screen.getAllByRole('row');
  expect(rows).toHaveLength(3);
});

test('keeps every provider editable through the shared override fields', () => {
  renderCost({ providers: [providerFixture('primary')], writable: true });

  for (const input of screen.getAllByRole('spinbutton')) expect(input).toBeEnabled();
});

test('renders read-only when the config cannot be written', () => {
  renderCost({ providers: [providerFixture('primary')], writable: false });

  for (const input of screen.getAllByRole('spinbutton')) expect(input).toBeDisabled();
});
