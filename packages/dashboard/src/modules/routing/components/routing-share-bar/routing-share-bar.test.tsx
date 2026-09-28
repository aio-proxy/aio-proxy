import { m } from '@aio-proxy/i18n';
import { TooltipProvider } from '@aio-proxy/ui/components/tooltip';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderCatalogProvider } from '@/hooks/use-provider-catalog';
import { providerStub } from '@/lib/provider-fixtures';

import { RoutingShareBar } from './routing-share-bar';

const tiers = [
  {
    priority: 30,
    providers: [
      { providerId: 'primary', weight: 1, share: 0.5 },
      { providerId: 'fallback', weight: 1, share: 0.5 },
    ],
  },
] as const;

const actual = [
  { providerId: 'primary', actualShare: 0.93, successRate: 0.5, p95LatencyMs: 60, finalCount: 93n },
  { providerId: 'fallback', actualShare: 0.07, successRate: 1, p95LatencyMs: 10, finalCount: 7n },
] as const;

test('shows the configured share beside each Provider', () => {
  render(<RoutingShareBar tiers={tiers} actual={undefined} />);

  expect(screen.getByText('primary')).toBeInTheDocument();
  expect(screen.getByText('fallback')).toBeInTheDocument();
  expect(screen.getAllByText('50%')).toHaveLength(2);
});

test('omits the actual row entirely when traffic is unknown', () => {
  const { container } = render(<RoutingShareBar tiers={tiers} actual={undefined} />);

  // Absent is not zero: a 0-width overlay would read as "actual share is zero".
  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(0);
});

test('shows actual shares once traffic is known', () => {
  const { container } = render(<RoutingShareBar tiers={tiers} actual={actual} />);

  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(1);
  expect(screen.getByTestId('routing-share-actual')).toHaveTextContent(m['dashboard.routing.share.actual']());
  expect(screen.getByText('93%')).toBeInTheDocument();
  expect(screen.getByText('7%')).toBeInTheDocument();
});

test('keeps a silent provider in position instead of shifting the tier left', () => {
  // The actual row once mapped only the providers that had traffic, so a provider serving nothing
  // dropped out and its neighbour's segment slid under its configured share — the operator read
  // the surviving provider as over-serving when the split was the exact opposite.
  render(
    <RoutingShareBar
      tiers={tiers}
      actual={[{ providerId: 'fallback', actualShare: 1, successRate: 1, p95LatencyMs: 10, finalCount: 7n }]}
    />,
  );

  expect(screen.getByText('0%')).toBeInTheDocument();
  expect(screen.getByText('100%')).toBeInTheDocument();
});

test('labels each row by tier and exposes its priority on the tier tooltip', async () => {
  render(
    <TooltipProvider>
      <RoutingShareBar tiers={tiers} actual={undefined} />
    </TooltipProvider>,
  );

  const tierLabel = screen.getByText(m['dashboard.routing.tier_label.tier']({ value: 1 }));
  expect(tierLabel).toBeInTheDocument();
  expect(screen.getAllByText('50%')).toHaveLength(2);
  fireEvent.pointerEnter(tierLabel, { pointerType: 'mouse' });
  fireEvent.mouseEnter(tierLabel);
  expect(await screen.findByText(m['dashboard.routing.tier_label.priority']({ value: 30 }))).toBeInTheDocument();
});

test('keeps a long Provider list compact and exposes the full summary on hover', () => {
  const providers = Array.from({ length: 5 }, (_, index) => ({
    providerId: `provider-${index + 1}`,
    weight: 1,
    share: 0.2,
  }));

  render(<RoutingShareBar tiers={[{ priority: 0, providers }]} actual={undefined} />);

  expect(screen.getByText('+2')).toBeInTheDocument();
  expect(
    screen.getByTitle('provider-1 20% · provider-2 20% · provider-3 20% · provider-4 20% · provider-5 20%'),
  ).toBeInTheDocument();
});

test('uses the shared Provider display name in the share list', () => {
  render(
    <ProviderCatalogProvider
      value={{ providers: [providerStub({ id: 'primary', name: 'Model Hub' })], plugins: [], status: 'ready' }}
    >
      <RoutingShareBar tiers={tiers} actual={undefined} />
    </ProviderCatalogProvider>,
  );

  expect(screen.getByText('Model Hub')).toBeInTheDocument();
});

test('draws each priority tier actual shares in its own row', () => {
  const { container } = render(
    <RoutingShareBar
      tiers={[
        { priority: 30, providers: [{ providerId: 'primary', weight: 1, share: 1 }] },
        { priority: 0, providers: [{ providerId: 'fallback', weight: 1, share: 1 }] },
      ]}
      actual={[
        { providerId: 'primary', actualShare: 1, successRate: 1, p95LatencyMs: 10, finalCount: 1n },
        { providerId: 'fallback', actualShare: 1, successRate: 1, p95LatencyMs: 20, finalCount: 1n },
      ]}
    />,
  );

  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(2);
  expect(screen.getByText(m['dashboard.routing.tier_label.tier']({ value: 1 }))).toBeInTheDocument();
  expect(screen.getByText(m['dashboard.routing.tier_label.tier']({ value: 2 }))).toBeInTheDocument();
});

test('renders a disabled badge when no tier has an eligible provider', () => {
  render(<RoutingShareBar tiers={[]} actual={undefined} />);

  expect(screen.getByText(/Disabled|禁用/u)).toBeInTheDocument();
});
