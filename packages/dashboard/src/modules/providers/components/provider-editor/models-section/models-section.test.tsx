import { m } from '@aio-proxy/i18n';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { Toaster } from '@aio-proxy/ui/components/toast';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import {
  type ProviderEditorForm,
  type ProviderEditorInitial,
  useProviderEditorForm,
} from '../../../hooks/use-provider-editor-form';
import type { ProviderAlias } from '../../../lib/alias-editor';
import { PROVIDER_MODELS_PLACEHOLDER } from '../../../lib/constants';
import { ModelsSection } from './models-section';

const mocks = rs.hoisted(() => ({ fetchCatalog: rs.fn(), fetchEditView: rs.fn(), refreshCatalog: rs.fn() }));

// Only the service boundary is mocked. `@tanstack/react-query` stays real: a stubbed `useMutation`
// whose `mutate` never resolves makes every catalog assertion pass regardless of the button.
rs.mock('../../../services/provider-draft', () => ({
  fetchProviderDraftCatalog: mocks.fetchCatalog,
  testProviderDraftModel: rs.fn(),
}));
rs.mock('../../../services/provider-catalog-refresh-service', () => ({
  refreshProviderCatalog: mocks.refreshCatalog,
}));
rs.mock('../../../services/providers-service', () => ({
  fetchProviderEditView: mocks.fetchEditView,
  providerEditViewQueryOptions: (id: string) => ({
    queryKey: ['providers', id, 'edit-view'],
    queryFn: () => mocks.fetchEditView(id),
  }),
}));

const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
});
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  // The catalog-failure surface is a toast, so the viewport that renders it has to be in the tree or
  // the assertion would pass against an absence rather than against the message.
  <QueryClientProvider client={queryClient}>
    {children}
    <Toaster />
  </QueryClientProvider>
);

let section: ProviderEditorForm;

interface HarnessProps {
  readonly kind: ProviderKind;
  readonly initial: ProviderEditorInitial;
  readonly candidates?: readonly string[] | undefined;
  readonly pluginAliases?: ProviderAlias | undefined;
  readonly persistedProviderId?: string | undefined;
}

const Harness: React.FC<HarnessProps> = ({ kind, initial, candidates, pluginAliases, persistedProviderId }) => {
  const form = useProviderEditorForm({ kind, initial });
  section = form;
  return (
    <ModelsSection
      form={form}
      kind={kind}
      persistedProviderId={persistedProviderId}
      candidates={candidates}
      pluginAliases={pluginAliases}
      summary={{ status: 'ok', hint: '' }}
    />
  );
};

const renderSection = (props: HarnessProps) => render(<Harness {...props} />, { wrapper });

const CLIENT_ID_LABEL = /Client model ID|客户端模型 ID/u;
const UPSTREAM_LABEL = /Upstream model|上游模型/u;

// Open the alias row's target picker and read back the option labels it offers.
const targetOptions = async () => {
  const card = await screen.findByTestId('provider-alias-card');
  fireEvent.click(within(card).getByLabelText(UPSTREAM_LABEL));
  const options = await screen.findAllByRole('option');
  return options.map((option) => option.textContent);
};

const apiInitial = (models: readonly string[]) => ({
  kind: ProviderKind.Api,
  id: 'provider',
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: 'https://api.example/v1',
  models,
});

beforeEach(() => {
  mocks.fetchCatalog.mockReset();
  mocks.fetchEditView.mockReset();
  mocks.refreshCatalog.mockReset();
  mocks.refreshCatalog.mockResolvedValue([]);
  queryClient.clear();
});

describe('ModelsSection', () => {
  test('renders one row per whitelisted model', () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a', 'model-b']),
    });

    expect(within(screen.getByTestId('model-row-model-a')).getByText('model-a')).toBeInTheDocument();
    expect(screen.getByTestId('model-row-model-b')).toBeInTheDocument();
    expect(screen.getByTestId('models-rows').children).toHaveLength(2);
  });

  test('with no models the empty card says so and names the two ways out', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial([]) });

    const empty = screen.getByTestId('models-empty');
    expect(empty).toHaveTextContent(m['dashboard.providers.form.models_empty_title']());
    // The instruction is the half a bare muted line drops: pull the catalog, or type an id.
    expect(empty).toHaveTextContent(m['dashboard.providers.form.models_empty_description']());
  });

  test('a filter matching nothing keeps the list and does not swap in the empty card', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.change(screen.getByTestId('models-filter'), { target: { value: 'no-such-model' } });

    expect(screen.getByTestId('models-rows').children).toHaveLength(0);
    expect(screen.queryByTestId('models-empty')).toBeNull();
    expect(screen.queryByText(m['dashboard.providers.form.models_filter_no_matches']())).toBeNull();
  });

  // A class assertion cannot see the htmlFor binding; only a click on the id can.
  test('clicking a model id toggles its checkbox', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']), candidates: ['model-a'] });

    const row = screen.getByTestId('model-row-model-a');
    expect(within(row).getByRole('checkbox')).toBeChecked();

    fireEvent.click(within(row).getByText('model-a'));

    await waitFor(() => expect(section.state.values.models).toEqual([]));
    expect(within(screen.getByTestId('model-row-model-a')).getByRole('checkbox')).not.toBeChecked();
  });

  test('the catalog button sits in the section header, not in the body', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    const catalog = screen.getByTestId('models-catalog-load');
    expect(within(screen.getByTestId('provider-editor-field-models')).queryByTestId('models-catalog-load')).toBeNull();
    // Asserted against the header itself rather than the button's immediate parent: the action lives in
    // its own slot beside the heading, so a parent-identity check would break on any header regrouping
    // while still passing if the button were moved to a different card's header entirely.
    const header = catalog.closest('[data-slot="card-header"]');
    expect(header).not.toBeNull();
    expect(header).toContainElement(screen.getByRole('heading', { level: 2 }));
  });

  test('manual add prepends a row and writes it to the form', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    const input = screen.getByLabelText(m['dashboard.providers.editor.models_manual_add']());
    fireEvent.change(input, { target: { value: 'model-z' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByTestId('model-row-model-z')).toBeInTheDocument());
    expect(section.state.values.models).toEqual(['model-z', 'model-a']);
    expect(screen.getByTestId('models-rows').firstElementChild).toHaveAttribute('data-testid', 'model-row-model-z');
  });

  test('an oauth provider with an empty denylist counts every discovered row as enabled', () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', excludedModels: [] },
      candidates: ['disc-a', 'disc-b', 'disc-c'],
    });

    expect(screen.getByTestId('models-count')).toHaveTextContent(
      m['dashboard.providers.editor.models_count']({ enabled: 3, total: 3 }),
    );
  });

  // An empty oauth whitelist means "expose the whole discovered catalog" to the runtime
  // (`exposedModelIds` treats absent and length-0 alike), and the editor's own create flow saves a
  // provider with no `models` key. Rendering those rows unchecked misreports what is live, and the
  // first click then committed a one-model whitelist — silently disabling everything else.
  test('an oauth provider with an empty denylist renders every discovered model as enabled', async () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', excludedModels: [] },
      candidates: ['disc-a', 'disc-b', 'disc-c'],
    });

    for (const id of ['disc-a', 'disc-b', 'disc-c']) {
      expect(within(screen.getByTestId(`model-row-${id}`)).getByRole('checkbox')).toBeChecked();
    }

    fireEvent.click(within(screen.getByTestId('model-row-disc-a')).getByRole('checkbox'));

    await waitFor(() => expect(section.state.values.excludedModels).toEqual(['disc-a']));
    expect(section.state.values).not.toHaveProperty('models');
  });

  test('a row without a discovered catalog still has a checkbox and a remove control', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    const row = screen.getByTestId('model-row-model-a');
    expect(within(row).getByRole('checkbox')).toBeChecked();
    expect(within(row).getByTestId('model-row-remove')).toBeInTheDocument();
  });

  // The placeholder is a comma-separated pair, and the box used to take the whole string as a single
  // id — so a user following the field's own hint got one model literally named `gpt-5-mini, gpt-5`,
  // rendered as a normal row and written to config with no validation and no error.
  test('comma-separated ids in the manual box become one row each, newest first', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['kept']) });

    const input = screen.getByLabelText(m['dashboard.providers.editor.models_manual_add']());
    fireEvent.change(input, { target: { value: PROVIDER_MODELS_PLACEHOLDER } });
    fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.form.models_manual_submit']() }));

    await waitFor(() => expect(section.state.values.models).toEqual(['gpt-5-mini', 'gpt-5', 'kept']));
    expect(screen.queryByTestId(`model-row-${PROVIDER_MODELS_PLACEHOLDER}`)).toBeNull();
  });

  test('retyping an already-listed id clears the box and does not move the row', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a', 'model-b']) });

    const input = screen.getByLabelText(m['dashboard.providers.editor.models_manual_add']()) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'model-b' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(input.value).toBe(''));
    expect(section.state.values.models).toEqual(['model-a', 'model-b']);
    expect(screen.getByTestId('models-rows').children).toHaveLength(2);
  });

  // The section's primary action, and nothing pinned it end to end: the loaded catalog has to reach
  // the row list, supersede the seeded candidates, and make its ids selectable without being silently
  // promoted into the whitelist.
  test('loading the catalog lists its models as unchecked rows and supersedes the seed', async () => {
    mocks.fetchCatalog.mockResolvedValue({ ok: true, models: ['model-a', 'fresh-b'] });
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']), candidates: ['seeded-c'] });

    expect(screen.getByTestId('model-row-seeded-c')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('models-catalog-load'));

    await waitFor(() => expect(screen.getByTestId('model-row-fresh-b')).toBeInTheDocument());
    expect(screen.queryByTestId('model-row-seeded-c')).toBeNull();
    expect(within(screen.getByTestId('model-row-fresh-b')).getByRole('checkbox')).not.toBeChecked();
    expect(within(screen.getByTestId('model-row-model-a')).getByRole('checkbox')).toBeChecked();
    // Discovering a model is not enabling it.
    expect(section.state.values.models).toEqual(['model-a']);
    expect(screen.getByTestId('models-count')).toHaveTextContent(
      m['dashboard.providers.editor.models_count']({ enabled: 1, total: 2 }),
    );
  });

  // The rows sit in a fixed-height scroller that keeps its offset, so a row that changes position on
  // being ticked drags every row after it under the pointer: the second click of a run of ticks landed
  // on a model the user never aimed at.
  test('ticking a catalog row leaves every row where it was', async () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['listed']),
      candidates: ['disc-a', 'disc-b', 'disc-c'],
    });

    const order = () => [...screen.getByTestId('models-rows').children].map((row) => row.getAttribute('data-testid'));
    const before = order();

    fireEvent.click(within(screen.getByTestId('model-row-disc-c')).getByRole('checkbox'));

    await waitFor(() => expect(section.state.values.models).toContain('disc-c'));
    expect(order()).toEqual(before);
  });

  test('a failed catalog load toasts the error code instead of emptying the list', async () => {
    mocks.fetchCatalog.mockResolvedValue({ ok: false, error: { code: 'upstream_unauthorized', recoverable: true } });
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.click(screen.getByTestId('models-catalog-load'));

    // Found by text anywhere in the tree, so this fails both when the toast never fires and when the
    // message regresses to something pinned inside the section.
    await waitFor(() =>
      expect(
        screen.getByText(m['dashboard.providers.form.catalog_failed']({ code: 'upstream_unauthorized' })),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('provider-editor-field-models')).not.toHaveTextContent(
      m['dashboard.providers.form.catalog_failed']({ code: 'upstream_unauthorized' }),
    );
    expect(screen.getByTestId('model-row-model-a')).toBeInTheDocument();
  });

  // Aliases moved here from Routing (fidelity-rules D-F6): they rename the models this section picks,
  // so the target picker and the list it draws from sit under one heading.
  //
  // Spec change 6 made an alias-only provider (models: []) valid on both server and client. The draft
  // row is the surface that matters: `ProviderAliasConfigFields` only renders for an already-named
  // alias, so a fixture with an existing `alias` entry never mounts the draft and would pass green
  // while the authoring path stays broken.
  test('an empty whitelist offers no alias targets', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial([]), candidates: ['disc-a', 'disc-b'] });

    expect(screen.getByRole('button', { name: /Add Alias|添加别名/u })).toBeDisabled();
  });

  test('alias targets are the enabled models, not the rest of the catalog', async () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a']),
      candidates: ['disc-a', 'disc-b', 'model-a'],
    });

    fireEvent.click(screen.getByRole('button', { name: /Add Alias|添加别名/u }));

    expect(await targetOptions()).toEqual(['model-a']);
  });

  // The raw whitelist, never the fallback, feeds aliasEditorIssues: empty there correctly means "no
  // whitelist, so no target can be missing". The target here is absent from the catalog on purpose —
  // passing the fallback instead would flag it target-missing and mark the section invalid.
  test('an alias-only provider reports no target-missing issue', () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: { ...apiInitial([]), alias: { smart: { model: 'legacy-model', preserve: false } } },
      candidates: ['disc-a'],
    });

    const card = screen.getByTestId('provider-alias-card');
    expect(within(card).getByLabelText(UPSTREAM_LABEL)).not.toHaveAttribute('aria-invalid', 'true');
  });

  // A catalog-only row cannot leave the list: it comes from `discovered`, not the whitelist. Its trash
  // control is therefore disabled rather than enabled-and-inert — a dead enabled button reads as a
  // broken product, and clicking it dropped the alias while the row stayed on screen.
  test('a catalog-only row cannot be deleted, so its alias survives', () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: { ...apiInitial(['model-a']), alias: { smart: { model: 'disc-b', preserve: false } } },
      candidates: ['disc-b'],
    });

    const remove = within(screen.getByTestId('model-row-disc-b')).getByTestId('model-row-remove');
    expect(remove).toBeDisabled();
    fireEvent.click(remove);

    expect(screen.getByTestId('model-row-disc-b')).toBeInTheDocument();
    const card = screen.getByTestId('provider-alias-card');
    expect(within(card).getByLabelText(CLIENT_ID_LABEL)).toHaveValue('smart');
    expect(within(card).getByLabelText(UPSTREAM_LABEL)).toHaveTextContent('disc-b');
  });

  test('Add Alias stays on screen when there are no aliases, and is disabled without enabled models', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial([]) });

    expect(screen.getByRole('button', { name: /Add Alias|添加别名/u })).toBeDisabled();
    expect(screen.getByText(m['dashboard.providers.form.aliases_empty']())).toBeInTheDocument();
  });

  test('Add Alias is enabled once at least one model is enabled', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    expect(screen.getByRole('button', { name: /Add Alias|添加别名/u })).toBeEnabled();
  });

  // Same-name replace, end to end: the suggestion has to reach the form draft, not just the response,
  // because the alias only lives in the draft and the next save replaces the stored record wholesale.
  test('inherited plugin aliases appear without being written into the draft', () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', excludedModels: [] },
      candidates: ['model-a', 'model-b'],
      pluginAliases: { mini: { model: 'model-b', preserve: false } },
      persistedProviderId: 'oauth-provider',
    });

    expect(within(screen.getByTestId('provider-alias-card')).getByLabelText(UPSTREAM_LABEL)).toHaveTextContent(
      'model-b',
    );
    expect(section.state.values.alias ?? []).toEqual([]);
  });

  test('hiding an inherited alias persists false and restore removes the authored key', async () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', excludedModels: [] },
      candidates: ['model-a', 'model-b'],
      pluginAliases: { mini: { model: 'model-b', preserve: false } },
      persistedProviderId: 'oauth-provider',
    });

    fireEvent.click(screen.getByLabelText(m['dashboard.providers.form.hide_inherited_alias']({ alias: 'mini' })));
    await waitFor(() => expect(section.state.values.alias?.[0]?.origin).toBe('hidden'));

    fireEvent.click(screen.getByLabelText(m['dashboard.providers.form.restore_plugin_alias']({ alias: 'mini' })));
    await waitFor(() => expect(section.state.values.alias ?? []).toEqual([]));
  });

  test('turning inherit off does not snapshot plugin defaults into the draft', async () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', excludedModels: [] },
      candidates: ['model-a', 'model-b'],
      pluginAliases: { mini: { model: 'model-b', preserve: false } },
      persistedProviderId: 'oauth-provider',
    });

    fireEvent.click(screen.getByTestId('inherit-plugin-aliases-checkbox'));
    await waitFor(() => expect(section.state.values.pluginAliasInherit).toBe(false));
    expect(section.state.values.alias ?? []).toEqual([]);
    expect(screen.queryByTestId('provider-alias-card')).toBeNull();
  });

  test('a suggestion aimed at a hidden model does not appear as an inherited row', () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', excludedModels: ['model-b'] },
      candidates: ['model-a', 'model-b'],
      pluginAliases: { mini: { model: 'model-b', preserve: false } },
      persistedProviderId: 'oauth-provider',
    });

    expect(screen.queryByTestId('provider-alias-card')).toBeNull();
  });

  // The edit view only reads the persisted catalog, so without the forced refresh the button
  // re-renders the same rows for as long as the catalog policy's TTL has not expired.
  test('oauth providers render the models the forced refresh committed, not the seed', async () => {
    mocks.refreshCatalog.mockResolvedValue(['fresh-a']);
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', models: [] },
      candidates: ['seeded-c'],
      persistedProviderId: 'oauth-provider',
    });

    expect(screen.getByTestId('models-catalog-load')).toBeInTheDocument();
    expect(screen.getByTestId('model-row-seeded-c')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('models-catalog-load'));

    await waitFor(() => expect(screen.getByTestId('model-row-fresh-a')).toBeInTheDocument());
    expect(screen.queryByTestId('model-row-seeded-c')).toBeNull();
    expect(mocks.refreshCatalog).toHaveBeenCalledWith('oauth-provider');
    // The refresh answers with the list it committed, so the editor needs no follow-up read.
    expect(mocks.fetchEditView).not.toHaveBeenCalled();
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  });

  test('a failed oauth refresh toasts the error code and keeps the models it could not replace', async () => {
    mocks.refreshCatalog.mockRejectedValue(new Error('upstream refused'));
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', models: [] },
      candidates: ['seeded-c'],
      persistedProviderId: 'oauth-provider',
    });

    fireEvent.click(screen.getByTestId('models-catalog-load'));

    await waitFor(() =>
      expect(
        screen.getByText(m['dashboard.providers.form.catalog_failed']({ code: 'catalog_unavailable' })),
      ).toBeInTheDocument(),
    );
    // The seed survives: a failed refresh must not blank the list it could not replace.
    expect(screen.getByTestId('model-row-seeded-c')).toBeInTheDocument();
  });

  test('the catalog button keeps its label while pending and names a reload after success', async () => {
    let resolveCatalog: ((value: { ok: true; models: string[] }) => void) | undefined;
    mocks.fetchCatalog.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    const button = screen.getByTestId('models-catalog-load');
    expect(button).toHaveTextContent(m['dashboard.providers.form.catalog_load']());
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent(m['dashboard.providers.form.catalog_load']());
    expect(button).not.toHaveTextContent(m['dashboard.providers.form.catalog_loading']());

    resolveCatalog?.({ ok: true, models: ['model-a', 'fresh-b'] });
    await waitFor(() => expect(button).toHaveTextContent(m['dashboard.providers.form.catalog_reload']()));
  });

  test('removing a model also drops aliases and variants that pointed at it', async () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: {
        ...apiInitial(['keep', 'drop']),
        alias: {
          gone: { model: 'drop', preserve: false },
          stay: {
            model: 'keep',
            preserve: false,
            variants: { high: { model: 'drop', preserve: false } },
          },
        },
      },
    });

    fireEvent.click(within(screen.getByTestId('model-row-drop')).getByTestId('model-row-remove'));

    await waitFor(() => expect(section.state.values.models).toEqual(['keep']));
    expect(section.state.values.alias).toEqual([
      expect.objectContaining({ name: 'stay', config: { model: 'keep', preserve: false } }),
    ]);
  });

  test('duplicate alias names raise a list-level alert', () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: {
        ...apiInitial(['model-a']),
        alias: {
          smart: { model: 'model-a', preserve: false },
          ' smart ': { model: 'model-a', preserve: false },
        },
      },
    });

    const summary = document.getElementById('alias-name-duplicate-error');
    expect(summary).not.toBeNull();
    expect(summary).toHaveAttribute('role', 'alert');
    expect(summary).toHaveTextContent(m['dashboard.providers.form.alias_name_duplicate']());
  });

  // Nesting, not styling: the card body spaces its blocks with `space-y-*`, which Tailwind compiles to a
  // direct-child combinator. Wrapping the blocks in anything — even a `display: contents` div, which was
  // the regression this guards — makes them grandchildren and the gap silently becomes 0.
  test('the models and alias blocks are direct children of the card body', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    const body = screen.getByTestId('provider-editor-field-models').parentElement;
    expect(body).toHaveAttribute('data-slot', 'card-content');
    expect(screen.getByTestId('provider-editor-field-alias').parentElement).toBe(body);
  });
});
