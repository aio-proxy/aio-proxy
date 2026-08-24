import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RoutingEditorDrawer } from './routing-editor-drawer';

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

const renderDrawer = (
  options: { readonly writable?: boolean; readonly onReload?: () => void; readonly model?: DashboardRoutingModel } = {},
) =>
  render(
    <RoutingEditorDrawer
      model={options.model ?? gpt5()}
      writable={options.writable ?? true}
      onOpenChange={rs.fn()}
      onReload={options.onReload ?? rs.fn()}
    />,
  );

test('renders Providers as a priority board with live shares', () => {
  renderDrawer();

  expect(screen.getByTestId('routing-board')).toBeInTheDocument();
  expect(screen.getByTestId('routing-share-a')).toHaveTextContent('60%');
  expect(screen.getByTestId('routing-share-b')).toHaveTextContent('40%');
  expect(screen.getByTestId('routing-disabled-c')).toBeInTheDocument();
});

test('Reset clears one Provider override back to inherit', async () => {
  renderDrawer();

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

test('Save sends the exact revision, baseline Provider IDs, and explicit override map', async () => {
  renderDrawer();

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

test('keeps the drawer open on 409 stale_revision and offers reload', async () => {
  const onReload = rs.fn();
  mocks.mutate.mockImplementation((_body: unknown, callbacks?: { onError?: (error: Error) => void }) => {
    const error = Object.assign(new Error('stale routing model'), { code: 'stale_revision' });
    mocks.error = error;
    callbacks?.onError?.(error);
  });
  renderDrawer({ onReload });

  fireEvent.click(screen.getByTestId('routing-save'));

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByTestId('routing-editor-drawer')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Reload|再読|다시|重新|重新/u }));
  expect(onReload).toHaveBeenCalled();
});

test('disables Save when writable is false while keeping read-only inspection', () => {
  renderDrawer({ writable: false });

  expect(screen.getByTestId('routing-save')).toBeDisabled();
  expect(
    screen.queryByLabelText(
      /Drag to change priority|拖动以调整优先级|拖曳以調整優先順序|ドラッグして優先度を変更|드래그하여 우선순위 변경/u,
    ),
  ).not.toBeInTheDocument();
  expect(screen.getByTestId('routing-share-a')).toHaveTextContent('60%');
  expect(screen.getByTestId('routing-provider-a')).toBeInTheDocument();
});

test('disables duplicate Save while a mutation is pending', () => {
  mocks.isPending = true;
  renderDrawer();

  expect(screen.getByTestId('routing-save')).toBeDisabled();
});

const dottedModel = (): DashboardRoutingModel => ({
  modelId: 'gpt-5',
  revision: 'rev-1',
  baselineProviderIds: ['acme.us', 'edge[west]'],
  providerCount: 2,
  eligibleProviderCount: 2,
  hasOverrides: true,
  tiers: [
    {
      priority: 30,
      providers: [
        { providerId: 'acme.us', weight: 6000, share: 0.6 },
        { providerId: 'edge[west]', weight: 4000, share: 0.4 },
      ],
    },
  ],
  providers: [
    provider({
      id: 'acme.us',
      name: 'Acme',
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
      id: 'edge[west]',
      name: 'Edge',
      override: { priority: routingNumber(30, 30), weight: routingNumber(4000, 4000) },
      effective: {
        priority: 30,
        weight: 4000,
        prioritySource: 'model',
        weightSource: 'model',
        eligible: true,
        share: 0.4,
      },
    }),
  ],
});

test('saves dotted and bracketed Provider IDs as exact payload keys', async () => {
  renderDrawer({ model: dottedModel() });

  expect(screen.getByTestId('routing-provider-acme.us')).toBeInTheDocument();
  expect(screen.getByTestId('routing-provider-edge[west]')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        modelId: 'gpt-5',
        revision: 'rev-1',
        baselineProviderIds: ['acme.us', 'edge[west]'],
        providers: {
          'acme.us': { priority: 30, weight: 6000 },
          'edge[west]': { priority: 30, weight: 4000 },
        },
      },
      expect.any(Object),
    );
  });
  expect(Object.keys(mocks.mutate.mock.calls[0]?.[0].providers ?? {})).toEqual(['acme.us', 'edge[west]']);
});

test('Reset on dotted and bracketed Provider IDs omits those keys from Save', async () => {
  renderDrawer({ model: dottedModel() });

  fireEvent.click(screen.getByTestId('routing-reset-acme.us'));
  fireEvent.click(screen.getByTestId('routing-reset-edge[west]'));
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        modelId: 'gpt-5',
        revision: 'rev-1',
        baselineProviderIds: ['acme.us', 'edge[west]'],
        providers: {},
      },
      expect.any(Object),
    );
  });
});
