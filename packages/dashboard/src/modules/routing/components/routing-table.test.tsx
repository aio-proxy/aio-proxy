import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

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

test('renders every known model including zero-eligible and single-Provider routes', () => {
  const onEdit = rs.fn();
  render(
    <RoutingTable
      onEdit={onEdit}
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
  expect(within(screen.getByTestId('routing-row-openai/gpt-5')).getByText(/P30/u)).toBeInTheDocument();
  expect(within(screen.getByTestId('routing-row-disabled-model')).getByText(/0\s*\/\s*1/u)).toBeInTheDocument();
});

test('filters models through the shared DataTable controls and opens Edit from a row', () => {
  const onEdit = rs.fn();
  const solo = model({ modelId: 'solo-model' });
  render(
    <RoutingTable
      onEdit={onEdit}
      models={[model({ modelId: 'openai/gpt-5' }), solo, model({ modelId: 'other-model' })]}
    />,
  );

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'solo-model' } });
  expect(screen.getByTestId('routing-row-solo-model')).toBeInTheDocument();
  expect(screen.queryByTestId('routing-row-openai/gpt-5')).toBeNull();

  fireEvent.click(
    within(screen.getByTestId('routing-row-solo-model')).getByRole('button', { name: /Edit|編集|편집|编辑|編輯/u }),
  );
  expect(onEdit).toHaveBeenCalledWith(solo);
});

test('paginates long model catalogs with the shared table pagination controls', () => {
  render(
    <RoutingTable
      onEdit={rs.fn()}
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
