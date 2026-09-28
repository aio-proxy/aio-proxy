import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { TooltipProvider } from '@aio-proxy/ui/components/tooltip';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';

import { ProviderCatalogProvider } from '@/hooks/use-provider-catalog';
import { providerStub } from '@/lib/provider-fixtures';

import { RoutingRoute } from './routing-route';

const routingNumber = (effective: number, authored?: number) => ({
  ...(authored === undefined ? {} : { authored }),
  effective,
  wasNormalized: authored !== undefined && authored !== effective,
});

const provider = (
  id: string,
  { priority = 0, weight = 1, eligible = true, enabled = true, fromModel = false } = {},
): DashboardRoutingProvider => ({
  id,
  kind: ProviderKind.Api,
  enabled,
  state: { status: 'ready' },
  defaults: { priority: routingNumber(priority), weight: routingNumber(weight) },
  ...(fromModel ? { override: { weight: routingNumber(weight) } } : {}),
  effective: {
    priority,
    weight,
    prioritySource: 'provider',
    weightSource: fromModel ? 'model' : 'provider',
    eligible,
    share: null,
  },
});

/** Tiers are derived the way the server does: eligible Providers grouped by priority, descending. */
const model = (providers: readonly DashboardRoutingProvider[]): DashboardRoutingModel => {
  const eligible = providers.filter((entry) => entry.effective.eligible);
  const priorities = [...new Set(eligible.map((entry) => entry.effective.priority))].sort((a, b) => b - a);
  return {
    modelId: 'model',
    revision: 'rev-1',
    baselineProviderIds: providers.map((entry) => entry.id),
    providerCount: providers.length,
    eligibleProviderCount: eligible.length,
    hasOverrides: providers.some((entry) => entry.override !== undefined),
    tiers: priorities.map((priority) => {
      const members = eligible.filter((entry) => entry.effective.priority === priority);
      const total = members.reduce((sum, entry) => sum + entry.effective.weight, 0);
      return {
        priority,
        providers: members.map((entry) => ({
          providerId: entry.id,
          weight: entry.effective.weight,
          share: entry.effective.weight / total,
        })),
      };
    }),
    providers,
  };
};

const totals = (providerId: string, finalCount: bigint) => ({
  providerId,
  finalCount,
  attemptCount: finalCount,
  successCount: finalCount,
  p95LatencyMs: 10,
});

const renderRoute = (element: ReactElement) => render(<TooltipProvider>{element}</TooltipProvider>);

const shareOf = (providerId: string) => within(screen.getByTestId(`routing-route-provider-${providerId}`));

test('lays out failover tiers in order and names each tier priority on hover', async () => {
  renderRoute(
    <RoutingRoute
      model={model([provider('primary', { priority: 100 }), provider('fallback', { priority: 0 })])}
      totals={undefined}
    />,
  );

  expect(within(screen.getByTestId('routing-tier-1')).getByTestId('routing-route-provider-primary')).toBeDefined();
  expect(within(screen.getByTestId('routing-tier-2')).getByTestId('routing-route-provider-fallback')).toBeDefined();

  const marker = screen.getByText(m['dashboard.routing.tier_label.short']({ value: 2 }));
  fireEvent.pointerEnter(marker, { pointerType: 'mouse' });
  fireEvent.mouseEnter(marker);
  expect(await screen.findByText(m['dashboard.routing.tier_label.fallback']())).toBeInTheDocument();
  expect(screen.getByText(new RegExp(m['dashboard.routing.tier_label.priority']({ value: 0 }), 'u'))).toBeDefined();
});

test('shows tier shares that add up to 100 and leaves a lone Provider unlabelled', () => {
  renderRoute(
    <RoutingRoute
      model={model([
        provider('a', { priority: 10 }),
        provider('b', { priority: 10 }),
        provider('c', { priority: 10 }),
        provider('solo', { priority: 0 }),
      ])}
      totals={undefined}
    />,
  );

  expect(shareOf('a').getByText('34%')).toBeInTheDocument();
  expect(shareOf('b').getByText('33%')).toBeInTheDocument();
  expect(shareOf('c').getByText('33%')).toBeInTheDocument();
  // 100% on a tier of one says nothing the tier row does not already say.
  expect(screen.getByTestId('routing-route-provider-solo')).not.toHaveTextContent('%');
});

test('shows the share rather than the raw weight, so a large weight reads like a small one', () => {
  renderRoute(
    <RoutingRoute
      model={model([provider('big', { weight: 9999 }), provider('tiny', { weight: 1 })])}
      totals={undefined}
    />,
  );

  expect(shareOf('big').getByText('100%')).toBeInTheDocument();
  // Rounded alone this is 0%, which would read as a Provider taking no traffic at all.
  expect(shareOf('tiny').getByText('<1%')).toBeInTheDocument();
  expect(screen.queryByText('9999')).toBeNull();
});

test('keeps Providers that take no traffic visible with the reason', () => {
  renderRoute(
    <RoutingRoute
      model={model([
        provider('live'),
        provider('off', { enabled: false, eligible: false }),
        provider('zero', { weight: 0, eligible: false }),
      ])}
      totals={undefined}
    />,
  );

  const ineligible = within(screen.getByTestId('routing-tier-ineligible'));
  expect(ineligible.getByTestId('routing-route-provider-off')).toHaveTextContent(
    m['dashboard.routing.route.off_disabled'](),
  );
  expect(ineligible.getByTestId('routing-route-provider-zero')).toHaveTextContent(
    m['dashboard.routing.route.off_zero_weight'](),
  );
  expect(ineligible.queryByTestId('routing-route-provider-live')).toBeNull();
});

test('marks only the Provider whose measured share ran off its configured one', () => {
  renderRoute(
    <RoutingRoute
      model={model([provider('primary'), provider('fallback')])}
      totals={[totals('primary', 93n), totals('fallback', 7n)]}
    />,
  );

  expect(shareOf('primary').getByText(/93%/u)).toBeInTheDocument();
  expect(shareOf('fallback').getByText(/7%/u)).toBeInTheDocument();
  expect(screen.getByTestId('routing-tier-actual')).toBeInTheDocument();
});

test('keeps a silent Provider in place as a measured zero', () => {
  // Traffic rows omit a Provider that served nothing. Mapping only the rows that exist once slid the
  // survivor under its neighbour's configured share, reading the split backwards.
  renderRoute(
    <RoutingRoute model={model([provider('primary'), provider('fallback')])} totals={[totals('fallback', 80n)]} />,
  );

  expect(shareOf('primary').getByText(/→ 0%/u)).toBeInTheDocument();
  expect(shareOf('fallback').getByText(/→ 100%/u)).toBeInTheDocument();
});

test('withholds measured shares while traffic is unknown', () => {
  renderRoute(<RoutingRoute model={model([provider('primary'), provider('fallback')])} totals={undefined} />);

  // Absent is not zero: an empty bar would read as "this tier served nothing".
  expect(screen.queryByTestId('routing-tier-actual')).toBeNull();
  expect(screen.queryByText(/→/u)).toBeNull();
});

test('marks a lone Provider whose weight comes from a model override', () => {
  renderRoute(<RoutingRoute model={model([provider('solo', { fromModel: true })])} totals={undefined} />);

  expect(screen.getByTestId('routing-route-provider-solo')).toHaveTextContent(m['dashboard.routing.route.override']());
});

test('identifies OAuth, API and AI SDK Providers by what users recognize them by', () => {
  renderRoute(
    <ProviderCatalogProvider
      value={{
        providers: [
          providerStub({
            id: 'oauth',
            kind: ProviderKind.OAuth,
            plugin: '@aio-proxy/plugin-cursor',
            // OAuth Providers commonly carry the account as their configured name; the service must
            // still lead, or every row reads as a bare email.
            name: 'me@example.com',
            accountLabel: 'me@example.com',
          }),
          providerStub({ id: 'api', kind: ProviderKind.Api, protocols: [ProviderProtocol.Anthropic] }),
          providerStub({ id: 'sdk', kind: ProviderKind.AiSdk, packageName: '@ai-sdk/amazon-bedrock' }),
        ],
        plugins: [
          {
            packageName: '@aio-proxy/plugin-cursor',
            displayName: 'Cursor',
            builtin: true,
            enabled: true,
            hasOptions: false,
            state: { status: 'ready' },
          },
        ],
        status: 'ready',
      }}
    >
      <RoutingRoute model={model([provider('oauth'), provider('api'), provider('sdk')])} totals={undefined} />
    </ProviderCatalogProvider>,
  );

  expect(screen.getByTestId('routing-route-provider-oauth')).toHaveTextContent(/Cursor.*me@example\.com/u);
  expect(screen.getByTestId('routing-route-provider-api')).toHaveTextContent(/api.*Anthropic/u);
  expect(screen.getByTestId('routing-route-provider-sdk')).toHaveTextContent(/sdk.*@ai-sdk\/amazon-bedrock/u);
});
