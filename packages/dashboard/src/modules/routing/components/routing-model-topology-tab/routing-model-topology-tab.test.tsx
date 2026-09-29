import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

const TopologyHarness: React.FC<{
  readonly actual: readonly RoutingTierShare[] | undefined;
}> = ({ actual }) => {
  const model = topologyModel();
  const form = useRoutingForm(model, rs.fn());
  return <RoutingModelTopologyTab form={form} model={model} writable={true} actual={actual} />;
};

const renderTopology = (options: { readonly actual: readonly RoutingTierShare[] | undefined }) =>
  render(<TopologyHarness actual={options.actual} />);

test('shows configured and actual share side by side on a provider row', () => {
  // The page exists to answer "I configured 50/50, why is it 93/7?" — both numbers must be
  // on the same row, not in separate tabs.
  renderTopology({ actual: [share('primary', 0.93, 0.5, 60)] });

  const row = within(screen.getByTestId('routing-row-primary'));
  expect(row.getByTestId('routing-share-primary')).toHaveTextContent('50%');
  expect(row.getByText('93%')).toBeInTheDocument();
});

test('shows the success rate that explains a collapsed share', () => {
  renderTopology({ actual: [share('primary', 0.07, 0.41, 20)] });

  expect(screen.getByText(/41%/u)).toBeInTheDocument();
});

test('reads a missing measurement as unknown, never as 0%', () => {
  // `actual` is undefined while traffic loads, after it fails, and when the window holds nothing;
  // "actual 0%" would claim the Provider served nothing, which none of the three establishes.
  renderTopology({ actual: undefined });

  expect(within(screen.getByTestId('routing-row-primary')).queryByText(/^0(\.0)?%$/u)).toBeNull();
});

test('shows no p95 when the sample was empty', () => {
  // null p95 means no sample; 0 would read as instant.
  renderTopology({ actual: [share('primary', 1, null, null)] });

  expect(screen.getByTestId('routing-row-primary')).not.toHaveTextContent(/\d+(\.\d+)?s/u);
});

test('a typed weight re-splits the tier once committed', () => {
  renderTopology({ actual: undefined });

  const weight = screen.getByTestId('routing-weight-primary');
  fireEvent.change(weight, { target: { value: '3' } });
  // Half-typed input must not reshuffle the tier before it is committed.
  expect(screen.getByTestId('routing-share-primary')).toHaveTextContent('50%');
  fireEvent.blur(weight);

  expect(screen.getByTestId('routing-share-primary')).toHaveTextContent('75%');
  expect(screen.getByTestId('routing-share-fallback')).toHaveTextContent('25%');
});

test('the weight stepper re-splits the tier, and speaks the dashboard locale', async () => {
  renderTopology({ actual: undefined });

  const row = within(screen.getByTestId('routing-row-primary'));
  // Base UI's default role description is English; the field must not pass it through.
  expect(screen.getByTestId('routing-weight-primary')).not.toHaveAttribute('aria-roledescription');

  const increase = row.getByRole('button', { name: m['common.increase']() });
  // A plain click is how assistive tech and keyboards activate the stepper: one step.
  fireEvent.click(increase);

  await waitFor(() => expect(screen.getByTestId('routing-share-primary')).toHaveTextContent('67%'));
  expect(screen.getByTestId('routing-share-fallback')).toHaveTextContent('33%');
});

test('the row menu moves a Provider into a tier of its own, like a drag would', async () => {
  renderTopology({ actual: undefined });
  expect(screen.getAllByTestId(/^routing-list-tier:/u)).toHaveLength(1);

  fireEvent.click(
    screen.getByRole('button', { name: m['dashboard.routing.detail.row_actions']({ providerId: 'fallback' }) }),
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: m['dashboard.routing.detail.move_to_new_tier']() }));

  await waitFor(() => expect(screen.getAllByTestId(/^routing-list-tier:/u)).toHaveLength(2));
  expect(
    within(screen.getAllByTestId(/^routing-list-tier:/u)[1] as HTMLElement).getByTestId('routing-row-fallback'),
  ).toBeInTheDocument();
});
