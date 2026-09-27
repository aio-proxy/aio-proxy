import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

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

test('gives every override field its own column so one field reads down the grid', () => {
  // The grid once had three headers above rows that each spanned all of them, so the headers
  // labelled nothing and every field name was repeated inside every Provider's cell.
  renderCost({ providers: [providerFixture('primary'), providerFixture('fallback')] });

  const headerRows = screen.getAllByRole('rowgroup')[0];
  const fieldNames = [
    m['dashboard.routing.editor.metadata_cost_label_input'](),
    m['dashboard.routing.editor.metadata_cost_label_output'](),
    m['dashboard.routing.editor.metadata_cost_label_cache_read'](),
    m['dashboard.routing.editor.metadata_cost_label_cache_write'](),
    m['dashboard.routing.editor.metadata_cost_label_reasoning'](),
    m['dashboard.routing.editor.metadata_limit_label_context'](),
    m['dashboard.routing.editor.metadata_limit_label_input'](),
    m['dashboard.routing.editor.metadata_limit_label_output'](),
  ];

  // Each field is named once, in the header, rather than once per Provider row.
  for (const name of fieldNames) {
    expect(screen.getAllByRole('columnheader', { name }).length).toBeGreaterThan(0);
    expect(headerRows).toHaveTextContent(name);
  }

  // One cell per (Provider, field), plus the Provider name cell — not one block per Provider.
  const row = screen.getByTestId('routing-overrides-primary');
  expect(row.querySelectorAll('td')).toHaveLength(fieldNames.length + 1);
});

test('lays providers out as rows rather than stacked blocks', () => {
  renderCost({ providers: [providerFixture('primary'), providerFixture('fallback')] });

  // Two grouped header rows plus one row per Provider.
  expect(screen.getAllByRole('row')).toHaveLength(4);
});

test('keeps every provider editable through the shared override fields', () => {
  renderCost({ providers: [providerFixture('primary')], writable: true });

  for (const input of screen.getAllByRole('spinbutton')) expect(input).toBeEnabled();
});

test('keeps each input reachable by its field name once the label is visually hidden', () => {
  // The column header carries the name on screen; assistive tech still needs it on the input.
  renderCost({ providers: [providerFixture('primary')] });

  expect(
    screen.getByRole('spinbutton', { name: m['dashboard.routing.editor.metadata_cost_label_cache_read']() }),
  ).toBeInTheDocument();
});

test('reports a limit that exceeds the context window without losing the grid row', () => {
  // The validation feedback used to sit inside each Provider's block. In a grid it needs a row of
  // its own, and that row must not displace the inputs it is describing.
  renderCost({ providers: [providerFixture('primary')] });

  fireEvent.change(
    screen.getByRole('spinbutton', { name: m['dashboard.routing.editor.metadata_limit_label_context']() }),
    {
      target: { value: '100' },
    },
  );
  fireEvent.change(
    screen.getByRole('spinbutton', { name: m['dashboard.routing.editor.metadata_limit_label_input']() }),
    {
      target: { value: '200' },
    },
  );

  expect(screen.getByTestId('routing-overrides-primary-limit-errors')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByTestId('routing-overrides-primary').querySelectorAll('td')).toHaveLength(9);
});

test('renders read-only when the config cannot be written', () => {
  renderCost({ providers: [providerFixture('primary')], writable: false });

  for (const input of screen.getAllByRole('spinbutton')) expect(input).toBeDisabled();
});
