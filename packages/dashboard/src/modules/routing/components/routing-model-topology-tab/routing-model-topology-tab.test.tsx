import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { useRoutingForm } from '../../hooks/use-routing-form';
import type { RoutingTierShare } from '../../lib/routing-traffic';
import { RoutingModelTopologyTab, type RoutingTrafficState } from './routing-model-topology-tab';

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

const TopologyHarness: React.FC<{
  readonly actual: readonly RoutingTierShare[] | undefined;
  readonly trafficState: RoutingTrafficState;
}> = ({ actual, trafficState }) => {
  const model = topologyModel();
  const form = useRoutingForm(model, rs.fn());
  return (
    <RoutingModelTopologyTab form={form} model={model} writable={true} actual={actual} trafficState={trafficState} />
  );
};

const renderTopology = (options: {
  readonly actual: readonly RoutingTierShare[] | undefined;
  readonly trafficState?: RoutingTrafficState;
}) => render(<TopologyHarness actual={options.actual} trafficState={options.trafficState ?? 'ready'} />);

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

test('says the window served nothing once traffic has actually been measured', () => {
  // Rendering "actual 0%" would claim the Provider served nothing, which is not known.
  renderTopology({ actual: undefined, trafficState: 'ready' });

  expect(screen.queryByText(/实际|actual/iu)).not.toBeInTheDocument();
  expect(screen.getByText(m['dashboard.routing.detail.no_traffic_yet']())).toBeInTheDocument();
});

test('does not call an in-flight traffic query a measured absence of traffic', () => {
  // This test used to cover the pending case under the "no traffic yet" copy, which reported a
  // measurement nobody had taken.
  renderTopology({ actual: undefined, trafficState: 'pending' });

  expect(screen.getByText(m['dashboard.routing.detail.traffic_pending']())).toBeInTheDocument();
  expect(screen.queryByText(m['dashboard.routing.detail.no_traffic_yet']())).not.toBeInTheDocument();
});

test('says so when traffic cannot be loaded at all', () => {
  // A failed query never resolves into a number, so "no traffic yet" would be permanent and wrong.
  renderTopology({ actual: undefined, trafficState: 'unavailable' });

  expect(screen.getByText(m['dashboard.routing.detail.traffic_unavailable']())).toBeInTheDocument();
  expect(screen.queryByText(m['dashboard.routing.detail.no_traffic_yet']())).not.toBeInTheDocument();
});

test('shows no p95 when the sample was empty', () => {
  // null p95 means no sample; 0 would read as instant.
  renderTopology({ actual: [share('primary', 1, null, null)] });

  expect(screen.queryByText(/p95/u)).not.toBeInTheDocument();
});
