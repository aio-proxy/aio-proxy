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
import { PROVIDER_MODELS_PLACEHOLDER } from '../../../lib/constants';
import { ModelsSection } from './models-section';

const mocks = rs.hoisted(() => ({ fetchCatalog: rs.fn(), fetchEditView: rs.fn(), slugs: rs.fn() }));

// Only the service boundary is mocked. `@tanstack/react-query` stays real: a stubbed `useMutation`
// whose `mutate` never resolves makes every catalog assertion pass regardless of the button.
rs.mock('../../../services/provider-draft', () => ({
  fetchProviderDraftCatalog: mocks.fetchCatalog,
  testProviderDraftModel: rs.fn(),
}));
rs.mock('../../../services/providers-service', () => ({
  fetchProviderEditView: mocks.fetchEditView,
  providerEditViewQueryOptions: (id: string) => ({
    queryKey: ['providers', id, 'edit-view'],
    queryFn: () => mocks.fetchEditView(id),
  }),
}));
rs.mock('../../../services/models-dev-service', () => ({
  modelsDevSlugsQueryOptions: () => ({ queryKey: ['models-dev-slugs'], queryFn: mocks.slugs }),
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
  readonly persistedProviderId?: string | undefined;
}

const Harness: React.FC<HarnessProps> = ({ kind, initial, candidates, persistedProviderId }) => {
  const form = useProviderEditorForm({ kind, initial });
  section = form;
  return (
    <ModelsSection
      form={form}
      kind={kind}
      persistedProviderId={persistedProviderId}
      candidates={candidates}
      summary={{ status: 'ok', hint: '' }}
    />
  );
};

const renderSection = (props: HarnessProps) => render(<Harness {...props} />, { wrapper });

const CLIENT_ID_LABEL = /Client model ID|客户端模型 ID/u;
const UPSTREAM_LABEL = /Upstream model|上游模型/u;

const limitContextLabel = () => m['dashboard.providers.editor.metadata_limit_label_context']();
const limitInputLabel = () => m['dashboard.providers.editor.metadata_limit_label_input']();
const costInputLabel = () => m['dashboard.providers.editor.metadata_cost_label_input']();
const costCacheReadLabel = () => m['dashboard.providers.editor.metadata_cost_label_cache_read']();
const costReasoningLabel = () => m['dashboard.providers.editor.metadata_cost_label_reasoning']();
const nameLabel = () => m['dashboard.providers.editor.metadata_field_label_name']();

// Open the alias row's target picker and read back the option labels it offers.
const targetOptions = async () => {
  const card = await screen.findByTestId('provider-alias-card');
  fireEvent.click(within(card).getByLabelText(UPSTREAM_LABEL));
  const options = await screen.findAllByRole('option');
  return options.map((option) => option.textContent);
};

const apiInitial = (models: readonly string[], metadata?: Record<string, Record<string, unknown>>) => ({
  kind: ProviderKind.Api,
  id: 'provider',
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: 'https://api.example/v1',
  models,
  ...(metadata === undefined ? {} : { metadata }),
});

beforeEach(() => {
  mocks.fetchCatalog.mockReset();
  mocks.fetchEditView.mockReset();
  mocks.slugs.mockReset();
  mocks.slugs.mockResolvedValue({ slugs: ['openai/gpt-5', 'anthropic/claude-opus-4'] });
  queryClient.clear();
});

describe('ModelsSection', () => {
  test('renders one row per whitelisted model and flags the ones carrying metadata', () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a', 'model-b'], { 'model-a': { name: 'A' } }),
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

  test('a row renders its limit.context override, and an em dash without one', () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['with-context', 'without-context'], { 'with-context': { limit: { context: 128_000 } } }),
    });

    expect(within(screen.getByTestId('model-row-with-context')).getByTestId('model-row-context')).toHaveTextContent(
      '128K',
    );
    expect(within(screen.getByTestId('model-row-without-context')).getByTestId('model-row-context')).toHaveTextContent(
      '—',
    );
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

  test('removing a row keeps metadata for models outside the whitelist', async () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a'], { 'model-a': { name: 'A' }, 'alias-only': { extend: 'openai/gpt-5' } }),
    });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-remove'));

    await waitFor(() => expect(section.state.values.models).toEqual([]));
    // applyModelRows must carry the alias-only record through; only model-a's record goes.
    expect(section.state.values.metadata).toEqual({ 'alias-only': { extend: 'openai/gpt-5' } });
  });

  test('an oauth provider with an empty whitelist counts every discovered row as enabled', () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', models: [] },
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
  test('an oauth provider with an empty whitelist renders every discovered model as enabled', async () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', models: [] },
      candidates: ['disc-a', 'disc-b', 'disc-c'],
    });

    for (const id of ['disc-a', 'disc-b', 'disc-c']) {
      expect(within(screen.getByTestId(`model-row-${id}`)).getByRole('checkbox')).toBeChecked();
    }

    fireEvent.click(within(screen.getByTestId('model-row-disc-a')).getByRole('checkbox'));

    // Unchecking one narrows the whitelist to the rest, rather than promoting it to the only model.
    await waitFor(() => expect(section.state.values.models).toEqual(['disc-b', 'disc-c']));
  });

  test('a row without a discovered catalog still has a checkbox and a remove control', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    const row = screen.getByTestId('model-row-model-a');
    expect(within(row).getByRole('checkbox')).toBeChecked();
    expect(within(row).getByTestId('model-row-remove')).toBeInTheDocument();
  });

  test('the metadata visual tab merges over fields it cannot edit instead of replacing them', async () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a'], {
        'model-a': { capabilities: { knowledge: '2024-06' }, limit: { context: 100 } },
      }),
    });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    const context = await screen.findByLabelText(limitContextLabel());
    fireEvent.change(context, { target: { value: '4096' } });
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));

    await waitFor(() =>
      expect(section.state.values.metadata?.['model-a']).toEqual({
        capabilities: { knowledge: '2024-06' },
        limit: { context: 4096 },
      }),
    );
  });

  test('the metadata visual tab accepts a fractional cost typed one keystroke at a time', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    const cost = (await screen.findByLabelText(costInputLabel())) as HTMLInputElement;
    // Append to the live DOM value rather than feeding absolute strings. The regression is React
    // rewriting the field at the `0.0` step, where `Number()` collapses the text to `0`; an absolute
    // next event would overwrite that rewrite, so the test would pass either way. Appending carries
    // the clobber forward — on the broken code the field accumulates to `75`.
    for (const character of '0.075') {
      fireEvent.change(cost, { target: { value: cost.value + character } });
    }

    expect(cost).toHaveValue(0.075);
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));
    await waitFor(() => expect(section.state.values.metadata?.['model-a']).toEqual({ cost: { input: 0.075 } }));

    // Clearing a money field must delete the key, not write `0`. Save closed the drawer, so reopen it.
    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');
    fireEvent.change(await screen.findByLabelText(costInputLabel()), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));
    await waitFor(() => expect(section.state.values.metadata?.['model-a']).toEqual({}));
  });

  test('the metadata visual tab cannot be entered while the JSON draft is unparseable', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a'], { 'model-a': { name: 'A' } }) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');
    expect(screen.getByTestId('metadata-tab-visual')).not.toHaveAttribute('aria-disabled', 'true');

    // Drop the closing brace: the visual tab merges over the parsed draft, so entering it on broken
    // text would write back an object missing every key the text still carries.
    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    fireEvent.change(await screen.findByTestId('metadata-json-draft'), { target: { value: '{"name":"A"' } });

    // Base UI marks a disabled tab with aria-disabled, not the native attribute.
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByTestId('metadata-tab-visual'));
    // keepMounted defaults to false, so the visual fields' absence is the assertion.
    expect(screen.queryByLabelText(limitContextLabel())).toBeNull();

    // Save is disabled on an unparseable draft, so this click is a no-op; the two assertions above
    // are the discriminating ones. This only pins that nothing lossy slips through anyway.
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));
    expect(section.state.values.metadata?.['model-a']).toEqual({ name: 'A' });

    // Emptying the textarea to start over has no keys to lose, so it must not lock the tab.
    fireEvent.change(screen.getByTestId('metadata-json-draft'), { target: { value: '  ' } });
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).not.toHaveAttribute('aria-disabled', 'true'));
  });

  // The drawer is a form, not a code editor: opening on the textarea was the shipped default and the
  // demo's first impression is the visual form. Only an unparseable draft may force JSON.
  test('the metadata drawer opens on the visual tab and an unparseable draft forces JSON', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a'], { 'model-a': { name: 'A' } }) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    // No click into the visual tab: the fields are there because visual is the default.
    expect(await screen.findByLabelText(limitContextLabel())).toBeInTheDocument();
    expect(screen.getByTestId('metadata-tab-visual')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('metadata-json-draft')).toBeNull();

    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    fireEvent.change(await screen.findByTestId('metadata-json-draft'), { target: { value: '{oops' } });
    await waitFor(() => expect(screen.getByTestId('metadata-tab-json')).toHaveAttribute('aria-selected', 'true'));

    // Controlled tabs still have to obey the user: repairing the draft and choosing visual must work,
    // or forcing json once would strand the user there for the rest of the session.
    fireEvent.change(screen.getByTestId('metadata-json-draft'), { target: { value: '{"name":"A"}' } });
    fireEvent.click(screen.getByTestId('metadata-tab-visual'));
    expect(await screen.findByLabelText(limitContextLabel())).toBeInTheDocument();
  });

  // A two-state switch reads an explicit `false` as "inherit" and silently converts it on save. Only a
  // three-state control can tell the two apart, so both directions are pinned here.
  test('a capability reads and writes explicit false, and inherit deletes the key', async () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a'], { 'model-a': { capabilities: { attachment: false, reasoning: true } } }),
    });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    const attachment = await screen.findByTestId('metadata-capability-attachment');
    expect(attachment).toHaveTextContent(m['dashboard.providers.editor.metadata_capability_unsupported']());
    expect(screen.getByTestId('metadata-capability-reasoning')).toHaveTextContent(
      m['dashboard.providers.editor.metadata_capability_supported'](),
    );

    // Inherit is the only choice that writes nothing.
    fireEvent.click(attachment);
    fireEvent.keyDown(
      await screen.findByRole('option', { name: m['dashboard.providers.editor.metadata_capability_inherit']() }),
      { key: 'Enter' },
    );
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));
    await waitFor(() =>
      expect(section.state.values.metadata?.['model-a']).toEqual({ capabilities: { reasoning: true } }),
    );

    // And unsupported writes the boolean rather than dropping the key.
    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');
    fireEvent.click(await screen.findByTestId('metadata-capability-toolCall'));
    fireEvent.keyDown(
      await screen.findByRole('option', { name: m['dashboard.providers.editor.metadata_capability_unsupported']() }),
      { key: 'Enter' },
    );
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));
    await waitFor(() =>
      expect(section.state.values.metadata?.['model-a']).toEqual({
        capabilities: { reasoning: true, toolCall: false },
      }),
    );
  });

  test('the newly exposed limit and cost fields round-trip into the draft', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    fireEvent.change(await screen.findByLabelText(limitInputLabel()), { target: { value: '8192' } });
    fireEvent.change(screen.getByLabelText(costCacheReadLabel()), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText(nameLabel()), { target: { value: 'GPT-5' } });
    // An empty number field must read as inherit, not as zero.
    expect(screen.getByLabelText(costReasoningLabel())).toHaveAttribute(
      'placeholder',
      m['dashboard.providers.editor.metadata_inherit_placeholder'](),
    );

    // The JSON tab is the same draft seen from the other side; a field wired to nothing shows up here.
    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    const draft = JSON.parse(((await screen.findByTestId('metadata-json-draft')) as HTMLTextAreaElement).value);
    expect(draft).toEqual({ name: 'GPT-5', limit: { input: 8192 }, cost: { cacheRead: 0.5 } });
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

  // An overflowing entry (`1e999` parses to Infinity) is the one numeric string the field cannot
  // store. Keeping its text on screen left the input showing a value the draft did not contain, so
  // the user read a context limit or a price that was never saved.
  test('a number the draft cannot hold is refused instead of being displayed', async () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a'], { 'model-a': { limit: { context: 4096 } } }),
    });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    const context = (await screen.findByLabelText(limitContextLabel())) as HTMLInputElement;
    fireEvent.change(context, { target: { value: '1e999' } });

    expect(context.value).toBe('4096');
    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    const draft = JSON.parse(((await screen.findByTestId('metadata-json-draft')) as HTMLTextAreaElement).value);
    expect(draft).toEqual({ limit: { context: 4096 } });
  });

  // An empty picker with no explanation is indistinguishable from a catalog with no models.
  test('a failed models.dev slug query explains itself and offers a retry', async () => {
    mocks.slugs.mockRejectedValue(new Error('offline'));
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    const retry = await screen.findByTestId('metadata-extend-retry');
    expect(screen.getByTestId('metadata-extend-status')).toHaveTextContent(
      m['dashboard.providers.editor.metadata_extend_error'](),
    );

    mocks.slugs.mockResolvedValue({ slugs: ['openai/gpt-5'] });
    fireEvent.click(retry);

    await waitFor(() =>
      expect(screen.getByTestId('metadata-extend-status')).toHaveTextContent(
        m['dashboard.providers.editor.metadata_extend_loaded']({ count: 1 }),
      ),
    );
  });

  // The clear button is icon-only, so without a name a screen reader announces it as just "button"
  // and a speech-input user has nothing to say. `packages/ui` carries no i18n, so the name has to
  // arrive as a prop from here.
  test('the extend picker names its clear button', async () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a'], { 'model-a': { extend: 'openai/gpt-5' } }),
    });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    expect(await screen.findByRole('button', { name: m['common.clear']() })).toBeInTheDocument();
  });

  test('visual metadata fields are named by prose, not config key paths', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    expect(await screen.findByLabelText(limitContextLabel())).toBeInTheDocument();
    expect(
      screen.getByLabelText(m['dashboard.providers.editor.metadata_capability_label_reasoning']()),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Temperature')).toBeInTheDocument();
    expect(screen.getByLabelText(nameLabel())).toHaveAttribute(
      'placeholder',
      m['dashboard.providers.editor.metadata_name_placeholder'](),
    );
    expect(screen.getByTestId('provider-model-metadata-save')).toHaveTextContent(
      m['dashboard.providers.actions.save_metadata'](),
    );
    expect(screen.queryByLabelText('limit.context')).toBeNull();
    expect(screen.queryByLabelText('capabilities.reasoning')).toBeNull();
  });

  test('broken JSON and a schema failure use different alerts, and only the former names the blocked tab', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a'], { 'model-a': { name: 'A' } }) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');
    fireEvent.click(screen.getByTestId('metadata-tab-json'));

    fireEvent.change(await screen.findByTestId('metadata-json-draft'), { target: { value: '{oops' } });
    const jsonAlert = await screen.findByRole('alert');
    expect(jsonAlert).toHaveTextContent(m['dashboard.providers.form.metadata_json_error']());
    expect(jsonAlert).toHaveAttribute('id', 'metadata-visual-blocked');
    expect(screen.getByTestId('metadata-tab-visual')).toHaveAttribute('aria-disabled', 'true');

    // A legal object that Zod rejects is still a form: the visual tab stays open, and the alert
    // has to name the field instead of claiming the draft is not an object.
    fireEvent.change(screen.getByTestId('metadata-json-draft'), {
      target: { value: JSON.stringify({ limit: { context: 100, input: 200 } }) },
    });
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).not.toHaveAttribute('aria-disabled', 'true'));
    const schemaAlert = screen.getByRole('alert');
    expect(schemaAlert).toHaveTextContent(
      m['dashboard.providers.form.metadata_schema_error']({
        path: 'limit.input',
        reason: 'Input limit must not exceed context limit',
      }),
    );
    expect(schemaAlert).not.toHaveAttribute('id', 'metadata-visual-blocked');
    expect(screen.getByTestId('provider-model-metadata-save')).toBeDisabled();
  });

  test('the extend picker is disabled only while the catalog is loading and no slug is set', async () => {
    mocks.slugs.mockReset();
    mocks.slugs.mockImplementation(() => new Promise(() => {}));
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    const empty = document.getElementById('metadata-extend');
    expect(empty).toBeDisabled();
    expect(empty).toHaveAttribute('placeholder', m['dashboard.providers.editor.metadata_extend_loading_placeholder']());
    expect(empty).toHaveAttribute('aria-label', m['dashboard.providers.editor.metadata_extend_aria_label']());
    expect(screen.getByRole('status')).toHaveTextContent(m['dashboard.providers.editor.metadata_extend_loading']());
  });

  test('an extend slug missing from the catalog stays in the picker so it can be selected again', async () => {
    mocks.slugs.mockResolvedValue({ slugs: ['openai/gpt-5'] });
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a'], { 'model-a': { extend: 'legacy/missing-slug' } }),
    });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');

    fireEvent.mouseDown(screen.getByRole('button', { expanded: false }));
    // The typed query is the saved slug itself, so the catalog hit is filtered out; the
    // discriminating check is that the missing slug is still an option and can be picked again.
    expect(await screen.findByRole('option', { name: 'legacy/missing-slug' })).toBeInTheDocument();
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

  // Every row renders the trash control, but a catalog-only row cannot leave the list: it comes from
  // `discovered`, not the whitelist. The click must therefore change nothing at all — dropping the
  // alias while the row stays on screen reads as "delete did nothing" and loses the alias on Save.
  test('deleting a catalog-only row leaves the alias pointing at it alone', () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: { ...apiInitial(['model-a']), alias: { smart: { model: 'disc-b', preserve: false } } },
      candidates: ['disc-b'],
    });

    fireEvent.click(within(screen.getByTestId('model-row-disc-b')).getByTestId('model-row-remove'));

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

  test('oauth providers still get a catalog button and refresh the edit-view catalog', async () => {
    mocks.fetchEditView.mockResolvedValue({
      provider: { id: 'oauth-provider', kind: 'oauth' },
      oauth: { accountLabel: 'acct', publicValues: {}, form: [], models: ['fresh-a'] },
    });
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
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
    expect(mocks.fetchEditView).toHaveBeenCalled();
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

  test('metadata cannot be opened on a disabled row', () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a']),
      candidates: ['model-a', 'disc-b'],
    });

    expect(within(screen.getByTestId('model-row-disc-b')).getByTestId('model-row-metadata')).toBeDisabled();
    expect(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata')).toBeEnabled();
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
