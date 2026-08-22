/* oxlint-disable max-lines */
import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { RoutingEditorSheet } from './routing-editor-sheet';

const mocks = rs.hoisted(() => ({
  mutate: rs.fn(),
  isPending: false,
  error: null as (Error & { code?: string }) | null,
  reset: rs.fn(),
}));

rs.mock('../hooks/use-routing-mutation', () => ({
  useRoutingMutation: () => ({
    mutate: mocks.mutate,
    isPending: mocks.isPending,
    error: mocks.error,
    reset: mocks.reset,
  }),
}));

afterEach(() => {
  mocks.mutate.mockReset();
  mocks.isPending = false;
  mocks.error = null;
  mocks.reset.mockReset();
});

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

const gpt5 = (): DashboardRoutingModel => ({
  modelId: 'openai/gpt-5',
  revision: 'rev-1',
  baselineProviderIds: ['a', 'b', 'c'],
  providerCount: 3,
  eligibleProviderCount: 2,
  hasOverrides: true,
  tiers: [
    {
      priority: 30,
      providers: [
        { providerId: 'a', weight: 6000, share: 0.6 },
        { providerId: 'b', weight: 4000, share: 0.4 },
      ],
    },
  ],
  providers: [
    provider({
      id: 'a',
      name: 'Primary',
      defaults: { priority: routingNumber(0), weight: routingNumber(1) },
      override: { priority: routingNumber(30, 30), weight: routingNumber(6000, 6000) },
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
      name: 'Secondary',
      defaults: { priority: routingNumber(30, 30), weight: routingNumber(4000, 4000) },
      effective: {
        priority: 30,
        weight: 4000,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 0.4,
      },
    }),
    provider({
      id: 'c',
      name: 'Inherited',
      defaults: { priority: routingNumber(20), weight: routingNumber(1000) },
      override: { weight: routingNumber(0, 0) },
      effective: {
        priority: 20,
        weight: 0,
        prioritySource: 'provider',
        weightSource: 'model',
        eligible: false,
        share: null,
      },
    }),
  ],
});

const renderSheet = (
  options: { readonly writable?: boolean; readonly onReload?: () => void; readonly model?: DashboardRoutingModel } = {},
) =>
  render(
    <RoutingEditorSheet
      model={options.model ?? gpt5()}
      writable={options.writable ?? true}
      onOpenChange={rs.fn()}
      onReload={options.onReload ?? rs.fn()}
    />,
  );

const overridePriority = (id: string) => screen.getByTestId(`routing-override-priority-${id}`);
const overrideWeight = (id: string) => screen.getByTestId(`routing-override-weight-${id}`);

test('treats blank priority and weight fields as inherit', () => {
  renderSheet();

  expect(overridePriority('b')).toHaveValue(null);
  expect(overrideWeight('b')).toHaveValue(null);
  expect(
    within(screen.getByTestId('routing-provider-b')).getAllByText(/inherit|継承|상속|继承|繼承/iu).length,
  ).toBeGreaterThan(0);
});

test('labels a Provider as disabled for the model when effective weight is zero', () => {
  renderSheet();

  expect(screen.getByTestId('routing-disabled-c')).toBeInTheDocument();
  expect(overrideWeight('c')).toHaveValue(0);
});

test('recomputes live tier shares when draft weights change', async () => {
  renderSheet();

  const preview = screen.getByTestId('routing-preview');
  expect(preview).toHaveTextContent('a');
  expect(preview).toHaveTextContent('60%');
  expect(preview).toHaveTextContent('40%');

  fireEvent.change(overrideWeight('a'), { target: { value: '1000' } });

  await waitFor(() => {
    expect(screen.getByTestId('routing-preview')).toHaveTextContent('20%');
    expect(screen.getByTestId('routing-preview')).toHaveTextContent('80%');
  });
});

test('Reset clears one Provider override back to inherit', async () => {
  renderSheet();

  expect(overridePriority('a')).toHaveValue(30);
  fireEvent.click(screen.getByTestId('routing-reset-a'));
  expect(overridePriority('a')).toHaveValue(null);
  expect(overrideWeight('a')).toHaveValue(null);
});

test('Save sends the exact revision, baseline Provider IDs, and explicit override map', async () => {
  renderSheet();

  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        modelId: 'openai/gpt-5',
        revision: 'rev-1',
        baselineProviderIds: ['a', 'b', 'c'],
        providers: {
          a: { priority: 30, weight: 6000 },
          c: { weight: 0 },
        },
      },
      expect.any(Object),
    );
  });
});

test('omits a Provider from Save after Reset leaves both fields blank', async () => {
  renderSheet();

  fireEvent.click(screen.getByTestId('routing-reset-a'));
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { c: { weight: 0 } },
      }),
      expect.any(Object),
    );
  });
});

test('keeps the Sheet open on 409 stale_revision and offers reload', async () => {
  const onReload = rs.fn();
  mocks.mutate.mockImplementation((_body: unknown, callbacks?: { onError?: (error: Error) => void }) => {
    const error = Object.assign(new Error('stale routing model'), { code: 'stale_revision' });
    mocks.error = error;
    callbacks?.onError?.(error);
  });
  renderSheet({ onReload });

  fireEvent.change(overrideWeight('a'), { target: { value: '1000' } });
  fireEvent.click(screen.getByTestId('routing-save'));

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByTestId('routing-editor-sheet')).toBeInTheDocument();
  expect(overrideWeight('a')).toHaveValue(1000);
  fireEvent.click(screen.getByRole('button', { name: /Reload|再読|다시|重新|重新/u }));
  expect(onReload).toHaveBeenCalled();
});

test('disables Save when writable is false while keeping read-only inspection', () => {
  renderSheet({ writable: false });

  expect(screen.getByTestId('routing-save')).toBeDisabled();
  expect(overridePriority('a')).toBeDisabled();
  expect(screen.getByTestId('routing-preview')).toHaveTextContent('a');
  expect(screen.getByTestId('routing-provider-a')).toBeInTheDocument();
});

test('disables duplicate Save while a mutation is pending', () => {
  mocks.isPending = true;
  renderSheet();

  expect(screen.getByTestId('routing-save')).toBeDisabled();
});
