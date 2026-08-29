import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as renderComponent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

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

rs.mock('../services/models-dev-service', () => ({
  modelsDevSlugsQueryOptions: () => ({
    queryKey: ['models-dev-slugs'],
    queryFn: async () => ({ slugs: ['openai/gpt-5'] }),
  }),
  modelsDevLookupQueryOptions: (id: string) => ({
    queryKey: ['models-dev-lookup', id],
    queryFn: async () => ({ slug: null, metadata: null }),
  }),
}));

rs.mock('@/components/json-editor/json-schema-registry', () => ({
  registerJsonSchema: () => () => undefined,
}));

rs.mock('@/components/json-editor/json-language-service', () => ({
  createJsonLanguageExtensions: () => [],
}));

rs.mock('@/components/code-editor', () => ({
  CodeEditor: ({
    id,
    onChange,
    value,
    invalid,
  }: {
    id?: string;
    onChange?: (next: string) => void;
    value: string;
    invalid?: boolean;
  }) => (
    <textarea
      id={id}
      value={value}
      aria-invalid={invalid ? 'true' : undefined}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

// The metadata editor's extend picker queries the models.dev slug catalog, so the tree needs a QueryClient.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const render = (ui: React.ReactElement) => renderComponent(ui, { wrapper });

const jsonDraftField = async (scope: ReturnType<typeof within> | typeof screen = screen) => {
  const host = await scope.findByTestId('metadata-json-draft');
  if (host instanceof HTMLTextAreaElement) return host;
  const textarea = host.querySelector('textarea');
  if (textarea === null) throw new Error('metadata json draft is missing a textarea');
  return textarea;
};

afterEach(() => {
  queryClient.clear();
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
  baselineProviderIds: ['a', 'b', 'c', 'd'],
  providerCount: 4,
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
    provider({
      id: 'd',
      name: 'Blocked',
      enabled: false,
      defaults: { priority: routingNumber(0), weight: routingNumber(1) },
      override: { weight: routingNumber(5, 5) },
      effective: {
        priority: 0,
        weight: 5,
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

test('moves the share slider thumb when the weight changes', () => {
  renderDrawer();

  fireEvent.change(screen.getByTestId('routing-share-slider-a').querySelector('input')!, {
    target: { value: '7000' },
  });

  const root = screen.getByTestId('routing-share-slider-a');
  const thumb = root.querySelector('[data-slot="slider-thumb"]') as HTMLElement;
  expect(screen.getByTestId('routing-share-a')).toHaveTextContent('70%');
  expect((root.querySelector('input') as HTMLInputElement).value).toBe('7000');
  expect(Number.parseFloat(thumb.style.insetInlineStart)).toBeCloseTo(70, 0);
});

const equalShare = (): DashboardRoutingModel => ({
  modelId: 'equal-share',
  revision: 'rev-1',
  baselineProviderIds: ['a', 'b'],
  providerCount: 2,
  eligibleProviderCount: 2,
  hasOverrides: false,
  tiers: [
    {
      priority: 0,
      providers: [
        { providerId: 'a', weight: 1, share: 0.5 },
        { providerId: 'b', weight: 1, share: 0.5 },
      ],
    },
  ],
  providers: [
    provider({
      id: 'a',
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
      id: 'b',
      name: 'Secondary',
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

test('keeps the share slider thumb visible for a 50/50 split', () => {
  renderDrawer({ model: equalShare() });

  const root = screen.getByTestId('routing-share-slider-a');
  const slider = root.querySelector('input') as HTMLInputElement;
  const thumb = root.querySelector('[data-slot="slider-thumb"]') as HTMLElement;
  expect(screen.getByTestId('routing-share-a')).toHaveTextContent('50%');
  expect(slider).not.toBeDisabled();
  expect(slider.min).toBe('0');
  expect(slider.max).toBe('10000');
  expect(slider.value).toBe('5000');
  expect(thumb.style.visibility).not.toBe('hidden');
  expect(Number.parseFloat(thumb.style.insetInlineStart)).toBeCloseTo(50, 0);

  fireEvent.change(slider, { target: { value: '7000' } });
  expect(screen.getByTestId('routing-share-a')).toHaveTextContent('70%');
  expect(screen.getByTestId('routing-share-b')).toHaveTextContent('30%');
});

const smallShare = (): DashboardRoutingModel => ({
  modelId: 'small-share',
  revision: 'rev-1',
  baselineProviderIds: ['a', 'b'],
  providerCount: 2,
  eligibleProviderCount: 2,
  hasOverrides: true,
  tiers: [
    {
      priority: 0,
      providers: [
        { providerId: 'a', weight: 2, share: 2 / 3 },
        { providerId: 'b', weight: 1, share: 1 / 3 },
      ],
    },
  ],
  providers: [
    provider({
      id: 'a',
      name: 'Primary',
      override: { weight: routingNumber(2, 2) },
      effective: {
        priority: 0,
        weight: 2,
        prioritySource: 'provider',
        weightSource: 'model',
        eligible: true,
        share: 2 / 3,
      },
    }),
    provider({
      id: 'b',
      name: 'Secondary',
      override: { weight: routingNumber(1, 1) },
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'model',
        eligible: true,
        share: 1 / 3,
      },
    }),
  ],
});

test('places small-weight thumbs on the displayed share', () => {
  renderDrawer({ model: smallShare() });

  const thumbA = screen
    .getByTestId('routing-share-slider-a')
    .querySelector('[data-slot="slider-thumb"]') as HTMLElement;
  const thumbB = screen
    .getByTestId('routing-share-slider-b')
    .querySelector('[data-slot="slider-thumb"]') as HTMLElement;
  expect(screen.getByTestId('routing-share-a')).toHaveTextContent('66.67%');
  expect(screen.getByTestId('routing-share-b')).toHaveTextContent('33.33%');
  expect(Number.parseFloat(thumbA.style.insetInlineStart)).toBeCloseTo(66.67, 0);
  expect(Number.parseFloat(thumbB.style.insetInlineStart)).toBeCloseTo(33.33, 0);
});

test('Reset stays available for a blocked Provider with a leftover override', async () => {
  renderDrawer();

  expect(screen.getByTestId('routing-list-blocked')).toBeInTheDocument();
  expect(screen.queryByTestId('routing-disabled-d')).not.toBeInTheDocument();
  expect(screen.getByTestId('routing-disabled-c')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('routing-reset-d'));
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { a: { priority: 30, weight: 6000 }, b: {}, c: { weight: 0 }, d: {} },
      }),
      expect.any(Object),
    );
  });
});

test('Reset clears one Provider override back to inherit', async () => {
  renderDrawer();

  fireEvent.click(screen.getByTestId('routing-reset-a'));
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { a: {}, b: {}, c: { weight: 0 }, d: { weight: 5 } },
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
        baselineProviderIds: ['a', 'b', 'c', 'd'],
        providers: {
          a: { priority: 30, weight: 6000 },
          b: {},
          c: { weight: 0 },
          d: { weight: 5 },
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

test('Reset on dotted and bracketed Provider IDs sends empty preservation patches', async () => {
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
        providers: { 'acme.us': {}, 'edge[west]': {} },
      },
      expect.any(Object),
    );
  });
});

const nameLabel = () => m['dashboard.routing.editor.metadata_field_label_name']();
const costInputLabel = () => m['dashboard.routing.editor.metadata_cost_label_input']();
const limitContextLabel = () => m['dashboard.routing.editor.metadata_limit_label_context']();
const limitInputLabel = () => m['dashboard.routing.editor.metadata_limit_label_input']();

/** gpt5 plus metadata and a cost/limit-only override on blocked Provider e. */
const withAuthoredMetadata = (): DashboardRoutingModel => {
  const base = gpt5();
  return {
    ...base,
    baselineProviderIds: [...base.baselineProviderIds, 'e'],
    providerCount: base.providerCount + 1,
    metadata: { name: 'Legacy' },
    providers: [
      ...base.providers.map((entry) =>
        entry.id === 'a'
          ? { ...entry, override: { ...entry.override, cost: { input: 3 }, limit: { context: 200_000 } } }
          : entry,
      ),
      provider({
        id: 'e',
        name: 'Metadata only',
        enabled: false,
        override: { cost: { input: 1 }, limit: { context: 8_000 } },
        effective: {
          priority: 0,
          weight: 1,
          prioritySource: 'provider',
          weightSource: 'provider',
          eligible: false,
          share: null,
        },
      }),
    ],
  };
};

test('the drawer renders the moved metadata editor with working Visual and JSON tabs', async () => {
  renderDrawer({ model: withAuthoredMetadata() });

  const editor = within(screen.getByTestId('model-metadata-editor'));
  expect(editor.getByTestId('metadata-tab-visual')).toHaveAttribute('aria-selected', 'true');
  expect(editor.getByLabelText(nameLabel())).toHaveValue('Legacy');

  fireEvent.click(editor.getByTestId('metadata-tab-json'));
  const draft = JSON.parse((await jsonDraftField(editor)).value);
  expect(draft).toEqual({ name: 'Legacy' });
});

test('per-provider cost and limit editors seed from the authored override', () => {
  renderDrawer({ model: withAuthoredMetadata() });

  const overridden = within(screen.getByTestId('routing-overrides-a'));
  expect(overridden.getByLabelText(costInputLabel())).toHaveValue(3);
  expect(overridden.getByLabelText(m['dashboard.routing.editor.metadata_limit_label_context']())).toHaveValue(200_000);
  // A provider without an authored override renders empty inherit fields, not zeros.
  expect(within(screen.getByTestId('routing-overrides-c')).getByLabelText(costInputLabel())).toHaveValue(null);
});

test('editing metadata and a Provider cost override puts both into the PUT body', async () => {
  renderDrawer();

  fireEvent.change(within(screen.getByTestId('model-metadata-editor')).getByLabelText(nameLabel()), {
    target: { value: 'GPT Five' },
  });
  fireEvent.change(within(screen.getByTestId('routing-overrides-a')).getByLabelText(costInputLabel()), {
    target: { value: '0.25' },
  });
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { name: 'GPT Five' },
        providers: {
          a: { priority: 30, weight: 6000, cost: { input: 0.25 } },
          b: {},
          c: { weight: 0 },
          d: { weight: 5 },
        },
      }),
      expect.any(Object),
    );
  });
});

test('clearing every metadata field sends metadata: null, and clearing a cost override sends cost: null', async () => {
  renderDrawer({ model: withAuthoredMetadata() });

  fireEvent.change(within(screen.getByTestId('model-metadata-editor')).getByLabelText(nameLabel()), {
    target: { value: '' },
  });
  fireEvent.change(within(screen.getByTestId('routing-overrides-a')).getByLabelText(costInputLabel()), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
  const body = mocks.mutate.mock.calls[0]?.[0] as {
    metadata?: unknown;
    providers: Record<string, Record<string, unknown>>;
  };
  expect(body.metadata).toBeNull();
  expect(body.providers['a']).toEqual({ priority: 30, weight: 6000, cost: null });
  // The untouched limit override survives by omission — no `limit` key, not `limit: null`.
  expect(body.providers['a']).not.toHaveProperty('limit');
});

// Invalid JSON stays local to the editor (the form keeps the last valid value), so an ungated Save
// would silently persist that stale value and close over the draft the user is looking at. The old
// provider drawer disabled Save in this state; the routing drawer must too.
// The PUT uses ModelLimitSchema; an input>context draft must not stay Save-enabled and then fail
// with the generic save-failed alert.
test('an invalid per-Provider limit disables Save and blocks submit', async () => {
  renderDrawer();

  const overrides = within(screen.getByTestId('routing-overrides-a'));
  fireEvent.change(overrides.getByLabelText(limitContextLabel()), { target: { value: '100' } });
  fireEvent.change(overrides.getByLabelText(limitInputLabel()), { target: { value: '200' } });

  const save = screen.getByTestId('routing-save');
  await waitFor(() => expect(save).toBeDisabled());
  fireEvent.submit(save.closest('form')!);
  expect(mocks.mutate).not.toHaveBeenCalled();
});

test('invalid metadata JSON disables Save and blocks submit until the draft is repaired', async () => {
  renderDrawer({ model: withAuthoredMetadata() });

  const editor = within(screen.getByTestId('model-metadata-editor'));
  fireEvent.click(editor.getByTestId('metadata-tab-json'));
  const draft = await jsonDraftField(editor);
  fireEvent.change(draft, { target: { value: '{ "name": "broken' } });

  const save = screen.getByTestId('routing-save');
  await waitFor(() => expect(save).toBeDisabled());
  // Keyboard submit bypasses the disabled button; the form-level gate must hold as well.
  fireEvent.submit(save.closest('form')!);
  expect(mocks.mutate).not.toHaveBeenCalled();

  fireEvent.change(draft, { target: { value: '{ "name": "repaired" }' } });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { name: 'repaired' } }),
      expect.any(Object),
    );
  });
});

// THE data-loss regression this task exists for: the board drafts are priority/weight-only BY
// DESIGN, so a board-only save must produce provider entries with NO cost/limit keys — paired
// with the server's preserve-on-absent contract, this is what keeps a drag or share change from
// deleting the cost/limit overrides and metadata the drawer editors own.
test('a board-only change produces a PUT body with no cost, limit, or metadata keys', async () => {
  renderDrawer({ model: withAuthoredMetadata() });

  // A share-slider move is the board flow: it rebuilds the priority/weight rows from scratch.
  fireEvent.change(screen.getByTestId('routing-share-slider-a').querySelector('input')!, {
    target: { value: '7000' },
  });
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
  const body = mocks.mutate.mock.calls[0]?.[0] as {
    metadata?: unknown;
    providers: Record<string, Record<string, unknown>>;
  };
  expect('metadata' in body).toBe(false);
  expect(body.providers['a']).toEqual({ priority: 30, weight: 7000 });
  // Provider e has only authored cost/limit metadata. Its empty submitted patch keeps the server
  // merge path alive while omission of the keys preserves those stored values.
  expect(body.providers['e']).toEqual({});
  for (const entry of Object.values(body.providers)) {
    expect(entry).not.toHaveProperty('cost');
    expect(entry).not.toHaveProperty('limit');
  }
});
