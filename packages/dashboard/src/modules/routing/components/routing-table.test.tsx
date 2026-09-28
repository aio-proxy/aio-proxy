import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';

import { ProviderCatalogProvider } from '@/hooks/use-provider-catalog';
import { providerStub } from '@/lib/provider-fixtures';

import { RoutingTable } from './routing-table';

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
    priority: 0,
    weight: 1,
    prioritySource: 'provider',
    weightSource: 'provider',
    eligible: true,
    share: 1,
  },
  ...values,
});

const modelFixture = (modelId: string, catalog?: { lab: string; releaseDate?: string }) => model({ modelId, catalog });

const model = (
  values: Partial<DashboardRoutingModel> & Pick<DashboardRoutingModel, 'modelId'>,
): DashboardRoutingModel => {
  const providers = values.providers ?? [provider({ id: 'only' })];
  return {
    revision: 'rev-1',
    baselineProviderIds: providers.map((entry) => entry.id),
    providerCount: providers.length,
    eligibleProviderCount: providers.filter((entry) => entry.effective.eligible).length,
    hasOverrides: providers.some((entry) => entry.override !== undefined),
    tiers: providers.some((entry) => entry.effective.eligible)
      ? [
          {
            priority: providers[0]?.effective.priority ?? 0,
            providers: providers
              .filter((entry) => entry.effective.eligible)
              .map((entry) => ({
                providerId: entry.id,
                weight: entry.effective.weight,
                share: entry.effective.share ?? 1,
              })),
          },
        ]
      : [],
    providers,
    ...values,
  };
};

const renderTable = async (table: ReactElement) => {
  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routing/',
    component: () => table,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routing/$',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/routing/'] }),
  });
  await router.load();
  return { ...render(<RouterProvider router={router} />), router };
};

test('renders every known model including zero-eligible and single-Provider routes', async () => {
  await renderTable(
    <RoutingTable
      traffic={undefined}
      models={[
        model({
          modelId: 'openai/gpt-5',
          providers: [
            provider({
              id: 'a',
              effective: {
                priority: 30,
                weight: 6000,
                prioritySource: 'model',
                weightSource: 'model',
                eligible: true,
                share: 0.6,
              },
            }),
            provider({
              id: 'b',
              effective: {
                priority: 30,
                weight: 4000,
                prioritySource: 'provider',
                weightSource: 'provider',
                eligible: true,
                share: 0.4,
              },
            }),
          ],
          tiers: [
            {
              priority: 30,
              providers: [
                { providerId: 'a', weight: 6000, share: 0.6 },
                { providerId: 'b', weight: 4000, share: 0.4 },
              ],
            },
          ],
          eligibleProviderCount: 2,
          providerCount: 2,
          hasOverrides: true,
        }),
        model({
          modelId: 'solo-model',
          providers: [provider({ id: 'solo' })],
          eligibleProviderCount: 1,
          providerCount: 1,
        }),
        model({
          modelId: 'disabled-model',
          providers: [
            provider({
              id: 'off',
              effective: {
                priority: 50,
                weight: 0,
                prioritySource: 'model',
                weightSource: 'model',
                eligible: false,
                share: null,
              },
            }),
          ],
          tiers: [],
          eligibleProviderCount: 0,
          providerCount: 1,
          hasOverrides: true,
        }),
      ]}
    />,
  );

  expect(screen.getByTestId('routing-row-openai/gpt-5')).toBeInTheDocument();
  expect(screen.getByTestId('routing-row-solo-model')).toBeInTheDocument();
  expect(screen.getByTestId('routing-row-disabled-model')).toBeInTheDocument();
  expect(within(screen.getByTestId('routing-row-openai/gpt-5')).getByText('60%')).toBeInTheDocument();
  expect(within(screen.getByTestId('routing-row-disabled-model')).getByText(/0\s*\/\s*1/u)).toBeInTheDocument();
});

test('renders an OAuth Provider service and account from the shared catalog', async () => {
  await renderTable(
    <ProviderCatalogProvider
      value={{
        providers: [
          providerStub({
            id: 'oauth-provider',
            kind: ProviderKind.OAuth,
            plugin: '@aio-proxy/plugin-openai-chatgpt',
            accountLabel: 'wang.baran@gmail.com',
          }),
        ],
        plugins: [
          {
            packageName: '@aio-proxy/plugin-openai-chatgpt',
            displayName: 'ChatGPT',
            builtin: true,
            enabled: true,
            hasOptions: false,
            state: { status: 'ready' },
          },
        ],
        status: 'ready',
      }}
    >
      <RoutingTable
        traffic={undefined}
        models={[
          model({ modelId: 'gpt-5', providers: [provider({ id: 'oauth-provider', kind: ProviderKind.OAuth })] }),
        ]}
      />
    </ProviderCatalogProvider>,
  );

  const providersCell = within(screen.getByTestId('routing-row-gpt-5')).getAllByRole('cell')[2];
  expect(providersCell).toHaveTextContent('ChatGPT · wang.baran@gmail.com');
  expect(providersCell).not.toHaveTextContent('OAuth');
  expect(within(providersCell).getByTitle('oauth-provider')).toBeInTheDocument();
});

test('does not render the column visibility control for the routing table', async () => {
  await renderTable(<RoutingTable models={[modelFixture('gpt-5')]} traffic={undefined} />);

  expect(screen.queryByRole('button', { name: /Columns|列/u })).not.toBeInTheDocument();
});

test('filters models through the shared DataTable controls', async () => {
  await renderTable(
    <RoutingTable
      traffic={undefined}
      models={[model({ modelId: 'openai/gpt-5' }), model({ modelId: 'solo-model' }), model({ modelId: 'other-model' })]}
    />,
  );

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'solo-model' } });
  expect(screen.getByTestId('routing-row-solo-model')).toBeInTheDocument();
  expect(screen.queryByTestId('routing-row-openai/gpt-5')).toBeNull();
});

test('paginates long model catalogs with the shared table pagination controls', async () => {
  await renderTable(
    <RoutingTable
      traffic={undefined}
      models={Array.from({ length: 12 }, (_, index) =>
        model({ modelId: `model-${String(index + 1).padStart(2, '0')}` }),
      )}
    />,
  );

  expect(screen.getByTestId('routing-row-model-01')).toBeInTheDocument();
  expect(screen.queryByTestId('routing-row-model-12')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Next|次|다음|下一|下一/u }));
  expect(screen.getByTestId('routing-row-model-12')).toBeInTheDocument();
});

test('groups rows by lab and repeats the header on each page', async () => {
  await renderTable(
    <RoutingTable
      models={[modelFixture('gpt-5', { lab: 'openai' }), modelFixture('claude', { lab: 'anthropic' })]}
      traffic={undefined}
    />,
  );

  expect(screen.getByTestId('routing-lab-group-anthropic')).toBeInTheDocument();
  expect(screen.getByTestId('routing-lab-group-openai')).toBeInTheDocument();
});

test('drops the lab group headers once the user sorts a column', async () => {
  await renderTable(<RoutingTable models={[modelFixture('gpt-5', { lab: 'openai' })]} traffic={undefined} />);

  fireEvent.click(screen.getByRole('button', { name: /Model ID/u }));

  expect(screen.getByRole('columnheader', { name: /Model ID/u })).toHaveAttribute('aria-sort', 'ascending');
  expect(screen.queryByTestId('routing-lab-group-openai')).not.toBeInTheDocument();
});

test('withholds a traffic value while the query has produced no index', async () => {
  // This test used to assert "No traffic" here, which encoded the bug: an in-flight or failed query
  // is unknown, and labelling it "no traffic" claims the model served nothing — permanently, once
  // the request has failed.
  await renderTable(<RoutingTable models={[modelFixture('gpt-5', { lab: 'openai' })]} traffic={undefined} />);

  expect(screen.queryByText(/No traffic|无流量/u)).not.toBeInTheDocument();
  expect(within(screen.getByTestId('routing-row-gpt-5')).getByText('—')).toBeInTheDocument();
});

test('shows no-traffic rather than zeros for a model the measured window has no rows for', async () => {
  // The query landed and this model simply served nothing in the window — a measured result, so the
  // label is the honest one here.
  await renderTable(<RoutingTable models={[modelFixture('gpt-5', { lab: 'openai' })]} traffic={new Map()} />);

  expect(screen.getByText(/No traffic|无流量/u)).toBeInTheDocument();
});

test('links each row to its detail page instead of opening a drawer', async () => {
  const { router } = await renderTable(
    <RoutingTable models={[modelFixture('anthropic/claude-sonnet-4.5')]} traffic={undefined} />,
  );

  const row = screen.getByTestId('routing-row-anthropic/claude-sonnet-4.5');
  expect(row).toHaveAttribute('role', 'link');
  expect(row).toHaveAttribute('tabindex', '0');
  fireEvent.keyDown(row, { key: 'Enter' });
  await waitFor(() => expect(router.state.location.pathname).toBe('/routing/anthropic/claude-sonnet-4.5'));
});

test('orders the traffic column numerically, across the whole BigInt range', async () => {
  // The accessor is a decimal string. Sorted as text, "10" lands before "9", and no numeric
  // coercion could separate neighbours past MAX_SAFE_INTEGER anyway — which is why these counts are
  // decoded as BigInt. The last fixture sits above that boundary.
  const totals = (providerId: string, finalCount: bigint) => ({
    providerId,
    finalCount,
    attemptCount: finalCount,
    successCount: finalCount,
    p95LatencyMs: 10,
  });

  await renderTable(
    <RoutingTable
      models={[modelFixture('huge'), modelFixture('nine'), modelFixture('ten')]}
      traffic={
        new Map([
          ['huge', [totals('huge-provider', 10_000_000_000_000_000n)]],
          ['nine', [totals('nine-provider', 9n)]],
          ['ten', [totals('ten-provider', 10n)]],
        ])
      }
    />,
  );

  const idsInOrder = () =>
    screen
      .getAllByTestId(/^routing-row-/u)
      .map((row) => row.getAttribute('data-testid'))
      .filter((id): id is string => id !== null);

  fireEvent.click(screen.getByRole('button', { name: /Traffic|流量/u }));
  expect(idsInOrder()).toStrictEqual(['routing-row-nine', 'routing-row-ten', 'routing-row-huge']);

  fireEvent.click(screen.getByRole('button', { name: /Traffic|流量/u }));
  expect(idsInOrder()).toStrictEqual(['routing-row-huge', 'routing-row-ten', 'routing-row-nine']);
});
