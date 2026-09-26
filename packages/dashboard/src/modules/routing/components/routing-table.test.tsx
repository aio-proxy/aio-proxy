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
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';

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
  return render(<RouterProvider router={router} />);
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
  expect(within(screen.getByTestId('routing-row-openai/gpt-5')).getByLabelText(/^a,/u)).toBeInTheDocument();
  expect(within(screen.getByTestId('routing-row-disabled-model')).getByText(/0\s*\/\s*1/u)).toBeInTheDocument();
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

test('shows no-traffic rather than zeros when traffic is absent', async () => {
  await renderTable(<RoutingTable models={[modelFixture('gpt-5', { lab: 'openai' })]} traffic={undefined} />);

  expect(screen.getByText(/No traffic|无流量/u)).toBeInTheDocument();
});

test('links each row to its detail page instead of opening a drawer', async () => {
  await renderTable(<RoutingTable models={[modelFixture('anthropic/claude-sonnet-4.5')]} traffic={undefined} />);

  expect(await screen.findByRole('link', { name: /编辑|Edit/u })).toHaveAttribute(
    'href',
    '/routing/anthropic/claude-sonnet-4.5',
  );
});
