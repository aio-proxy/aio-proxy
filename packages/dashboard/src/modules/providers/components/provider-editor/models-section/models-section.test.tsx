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
  return <ModelsSection form={form} kind={kind} candidates={candidates} status="ok" />;
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

    const cost = await screen.findByLabelText('cost.input');
    // Per character, not one `fireEvent.change`: the regression is React rewriting the field at the
    // `0.0` step, where `Number()` collapses the text to `0`. A whole-string change never sees it.
    for (const text of ['0', '0.', '0.0', '0.07', '0.075']) {
      fireEvent.change(cost, { target: { value: text } });
    }

    expect(cost).toHaveValue(0.075);
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));
    await waitFor(() => expect(section.state.values.metadata?.['model-a']).toEqual({ cost: { input: 0.075 } }));
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

    // The real guarantee: no lossy value can reach the form from this state.
    fireEvent.click(screen.getByTestId('provider-model-metadata-save'));
    expect(section.state.values.metadata?.['model-a']).toEqual({ name: 'A' });
  });
});
