import { m } from '@aio-proxy/i18n';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import { type ProviderEditorForm, useProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import type { ProviderEditorShape } from '../../../hooks/use-provider-editor-form';
import { ModelsSection } from './models-section';

const mocks = rs.hoisted(() => ({ fetchCatalog: rs.fn(), slugs: rs.fn() }));

// Only the service boundary is mocked. `@tanstack/react-query` stays real: a stubbed `useMutation`
// whose `mutate` never resolves makes every catalog assertion pass regardless of the button.
rs.mock('../../../services/provider-draft', () => ({
  fetchProviderDraftCatalog: mocks.fetchCatalog,
  testProviderDraftModel: rs.fn(),
}));
rs.mock('../../../services/models-dev-service', () => ({
  modelsDevSlugsQueryOptions: () => ({ queryKey: ['models-dev-slugs'], queryFn: mocks.slugs }),
}));

const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
});
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

let section: ProviderEditorForm;

interface HarnessProps {
  readonly kind: ProviderKind;
  readonly initial: Partial<ProviderEditorShape>;
  readonly candidates?: readonly string[] | undefined;
}

const Harness: React.FC<HarnessProps> = ({ kind, initial, candidates }) => {
  const form = useProviderEditorForm({ kind, initial });
  section = form;
  return <ModelsSection form={form} kind={kind} candidates={candidates} summary={{ status: 'ok', hint: '' }} />;
};

const renderSection = (props: HarnessProps) => render(<Harness {...props} />, { wrapper });

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

  // "This provider has no models" and "your search found nothing" are different problems with
  // different exits. One shared string passes every class and testid assertion, so this pins the copy.
  test('a filter matching nothing reads differently from having no models at all', () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.change(screen.getByTestId('models-filter'), { target: { value: 'no-such-model' } });

    const noMatches = screen.getByTestId('models-no-matches');
    expect(noMatches).toHaveTextContent(m['dashboard.providers.form.models_filter_no_matches']());
    expect(noMatches.textContent ?? '').not.toContain(m['dashboard.providers.form.models_empty_title']());
    expect(noMatches.textContent ?? '').not.toContain(m['dashboard.providers.form.models_empty_description']());
    // The provider does have models, so the no-models card must stay away.
    expect(screen.queryByTestId('models-empty')).toBeNull();
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
    // The header row is the element holding both the section heading and the action slot.
    expect(catalog.parentElement).toContainElement(screen.getByRole('heading', { level: 2 }));
  });

  test('manual add appends a row and writes it to the form', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.change(screen.getByTestId('models-manual-add-input'), { target: { value: 'model-z' } });
    fireEvent.click(screen.getByTestId('models-manual-add-button'));

    await waitFor(() => expect(screen.getByTestId('model-row-model-z')).toBeInTheDocument());
    expect(section.state.values.models).toEqual(['model-a', 'model-z']);
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

  test('an oauth provider with an empty whitelist reports the discovered count, substituted', () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', models: [] },
      candidates: ['disc-a', 'disc-b', 'disc-c'],
    });

    const count = screen.getByTestId('models-count');
    // The number, not the wording: an unsubstituted `{count}` is the regression this pins.
    expect(count).toHaveTextContent(/\b3\b/u);
    expect(count.textContent ?? '').not.toContain('{count}');
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

  test('a whitelisted model missing from the discovered catalog is called out as stale', () => {
    renderSection({
      kind: ProviderKind.OAuth,
      initial: { kind: ProviderKind.OAuth, id: 'oauth-provider', models: ['gone', 'disc-a'] },
      candidates: ['disc-a'],
    });

    const stale = within(screen.getByTestId('model-row-gone')).getByTestId('model-row-stale');
    expect(stale).toHaveTextContent(/gone/u);
    expect(stale.textContent ?? '').not.toContain('{model}');
    expect(within(screen.getByTestId('model-row-disc-a')).queryByTestId('model-row-stale')).toBeNull();
  });

  test('the metadata visual tab merges over fields it cannot edit instead of replacing them', async () => {
    renderSection({
      kind: ProviderKind.Api,
      initial: apiInitial(['model-a'], { 'model-a': { description: 'keep me', limit: { context: 100 } } }),
    });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');
    // Visual is the first tab; JSON is the default-selected one, so switch explicitly.
    fireEvent.click(screen.getAllByRole('tab')[0] as HTMLElement);

    const context = await screen.findByLabelText('limit.context');
    fireEvent.change(context, { target: { value: '4096' } });
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));

    await waitFor(() =>
      expect(section.state.values.metadata?.['model-a']).toEqual({
        description: 'keep me',
        limit: { context: 4096 },
      }),
    );
  });

  test('the metadata visual tab accepts a fractional cost typed one keystroke at a time', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a']) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');
    fireEvent.click(screen.getByTestId('metadata-tab-visual'));

    const cost = (await screen.findByLabelText('cost.input')) as HTMLInputElement;
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
    fireEvent.click(screen.getByTestId('metadata-tab-visual'));
    fireEvent.change(await screen.findByLabelText('cost.input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));
    await waitFor(() => expect(section.state.values.metadata?.['model-a']).toEqual({}));
  });

  test('the metadata visual tab cannot be entered while the JSON draft is unparseable', async () => {
    renderSection({ kind: ProviderKind.Api, initial: apiInitial(['model-a'], { 'model-a': { name: 'A' } }) });

    fireEvent.click(within(screen.getByTestId('model-row-model-a')).getByTestId('model-row-metadata'));
    await screen.findByTestId('provider-model-metadata-drawer');
    expect(screen.getByTestId('metadata-tab-visual')).not.toHaveAttribute('aria-disabled', 'true');

    // Drop the closing brace: the visual tab merges over the parsed draft, so entering it here would
    // write back an object missing `name` — a key the visual tab cannot even re-enter.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"name":"A"' } });

    // Base UI marks a disabled tab with aria-disabled, not the native attribute.
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByTestId('metadata-tab-visual'));
    // keepMounted defaults to false, so the visual fields' absence is the assertion.
    expect(screen.queryByLabelText('limit.context')).toBeNull();

    // Save is disabled on an unparseable draft, so this click is a no-op; the two assertions above
    // are the discriminating ones. This only pins that nothing lossy slips through anyway.
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));
    expect(section.state.values.metadata?.['model-a']).toEqual({ name: 'A' });

    // Emptying the textarea to start over has no keys to lose, so it must not lock the tab.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } });
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).not.toHaveAttribute('aria-disabled', 'true'));
  });
});
