import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { useRoutingForm } from '../../hooks/use-routing-form';
import type { RoutingTierShare } from '../../lib/routing-traffic';
import { RoutingModelTopologyTab } from './routing-model-topology-tab';

const routingNumber = (effective: number, authored?: number) => ({
  ...(authored === undefined ? {} : { authored }),
  effective,
  wasNormalized: authored !== undefined && authored !== effective,
});

const provider = (
  values: Partial<DashboardRoutingProvider> & Pick<DashboardRoutingProvider, 'id'>,
): DashboardRoutingProvider => ({
  kind: ProviderKind.Api,
  enabled: true,
  state: { status: 'ready' },
  defaults: { priority: routingNumber(0), weight: routingNumber(1) },
  effective: {
    priority: values.defaults?.priority.effective ?? 0,
    weight: values.defaults?.weight.effective ?? 1,
    prioritySource: values.override?.priority === undefined ? 'provider' : 'model',
    weightSource: values.override?.weight === undefined ? 'provider' : 'model',
    eligible:
      (values.enabled ?? true) && (values.override?.weight?.effective ?? values.defaults?.weight.effective ?? 1) > 0,
    share: null,
  },
  ...values,
});

const topologyModel = (): DashboardRoutingModel => ({
  modelId: 'topology-test',
  revision: 'rev-1',
  baselineProviderIds: ['primary', 'fallback'],
  providerCount: 2,
  eligibleProviderCount: 2,
  hasOverrides: false,
  tiers: [
    {
      priority: 0,
      providers: [
        { providerId: 'primary', weight: 1, share: 0.5 },
        { providerId: 'fallback', weight: 1, share: 0.5 },
      ],
    },
  ],
  providers: [
    provider({
      id: 'primary',
      name: 'Primary',
      defaults: { priority: routingNumber(0), weight: routingNumber(1) },
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 0.5,
      },
    }),
    provider({
      id: 'fallback',
      name: 'Fallback',
      defaults: { priority: routingNumber(0), weight: routingNumber(1) },
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 0.5,
      },
    }),
  ],
});

const share = (
  providerId: string,
  actualShare: number,
  successRate: number | null,
  p95LatencyMs: number | null,
): RoutingTierShare => ({
  providerId,
  actualShare,
  successRate,
  p95LatencyMs,
  finalCount: 1n,
});

const TopologyHarness: React.FC<{ readonly actual: readonly RoutingTierShare[] | undefined }> = ({ actual }) => {
  const model = topologyModel();
  const form = useRoutingForm(model, rs.fn());
  return <RoutingModelTopologyTab form={form} model={model} writable={true} actual={actual} />;
};

const renderTopology = (options: { readonly actual: readonly RoutingTierShare[] | undefined }) =>
  render(<TopologyHarness actual={options.actual} />);

test('shows configured and actual share side by side on a provider card', () => {
  // The page exists to answer "I configured 50/50, why is it 93/7?" — both numbers must be
  // on the same card, not in separate tabs.
  renderTopology({ actual: [share('primary', 0.93, 0.5, 60)] });

  expect(screen.getByText(/50%.*93%/u)).toBeInTheDocument();
});

test('shows the success rate that explains a collapsed share', () => {
  renderTopology({ actual: [share('primary', 0.07, 0.41, 20)] });

  expect(screen.getByText(/41%/u)).toBeInTheDocument();
});

test('omits actual numbers entirely when traffic is unavailable', () => {
  // Rendering "actual 0%" would claim the Provider served nothing, which is not known.
  renderTopology({ actual: undefined });

  expect(screen.queryByText(/实际|actual/iu)).not.toBeInTheDocument();
  expect(screen.getByText(/No traffic yet|暂无流量/u)).toBeInTheDocument();
});

test('shows no p95 when the sample was empty', () => {
  // null p95 means no sample; 0 would read as instant.
  renderTopology({ actual: [share('primary', 1, null, null)] });

  expect(screen.queryByText(/p95/u)).not.toBeInTheDocument();
});
