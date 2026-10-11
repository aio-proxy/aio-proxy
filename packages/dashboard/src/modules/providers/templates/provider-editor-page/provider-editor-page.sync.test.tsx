import { m } from '@aio-proxy/i18n';
import { ProviderKind, ProviderMutationBodySchema, ProviderProtocol } from '@aio-proxy/types';
import { Toaster } from '@aio-proxy/ui/components/toast';
import { beforeEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ProviderFormMode } from '../../lib/constants';
import * as providerOptionsSchemaService from '../../services/provider-options-schema-service' with {
  rstest: 'importActual',
};
import { ProviderEditorPage } from './provider-editor-page';

const mocks = rs.hoisted(() => ({
  catalog: rs.fn(),
  testDraft: rs.fn(),
  create: rs.fn(),
  update: rs.fn(),
  editView: rs.fn(),
  navigate: rs.fn(),
}));

// Keep Form and Query real so a catalog result must travel through the page's shared state.
rs.mock('../../services/provider-draft', () => ({
  fetchProviderDraftCatalog: mocks.catalog,
  testProviderDraftModel: mocks.testDraft,
}));
rs.mock('../../services/providers-service', () => ({
  fetchProviderEditView: mocks.editView,
  updateProviderMutationFn: mocks.update,
  createProviderMutationFn: mocks.create,
  deleteProviderMutationFn: rs.fn(),
}));
rs.mock('../../services/provider-options-schema-service', () => ({
  ...providerOptionsSchemaService,
  providerPackageStatusQueryOptions: (packageName: string) => ({
    queryKey: ['provider-package-status', packageName],
    queryFn: async () => ({ trusted: false, state: 'installed' }),
  }),
}));
rs.mock('../../services/oauth-service', () => ({
  oauthCapabilitiesQueryOptions: () => ({
    queryKey: ['oauth-capabilities'],
    queryFn: async () => ({ capabilities: [] }),
  }),
  oauthSessionQueryOptions: () => ({ queryKey: ['oauth-session'], queryFn: rs.fn(), enabled: false }),
  startOAuthSession: rs.fn(),
  submitOAuthCallback: rs.fn(),
  cancelOAuthSession: rs.fn(),
}));
rs.mock('@tanstack/react-router', () => ({
  Link: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
  useNavigate: () => mocks.navigate,
}));

beforeEach(() => {
  mocks.catalog.mockReset();
  mocks.catalog.mockResolvedValue({ ok: true, models: ['a', 'b'] });
  mocks.testDraft.mockReset();
  mocks.testDraft.mockResolvedValue({ ok: true });
  mocks.create.mockReset();
  mocks.create.mockResolvedValue({ provider: { id: 'provider' } });
  mocks.update.mockReset();
  mocks.update.mockResolvedValue({ provider: { id: 'provider' } });
  mocks.editView.mockReset();
});

test('a draft sync catalog updates preview, save status and test models together', async () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Toaster />
      <ProviderEditorPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.Api}
        providerId="provider"
        initial={{
          id: 'provider',
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: 'https://api.example/v1',
          models: ['old'],
        }}
        onSessionIdChange={rs.fn()}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId('models-sync-switch'));
  await screen.findByTestId('model-row-b');

  expect(screen.getByTestId('exposure-panel')).toHaveTextContent('a');
  expect(screen.getByTestId('exposure-panel')).toHaveTextContent('b');
  expect(screen.getByTestId('exposure-panel')).not.toHaveTextContent('old');
  const picker = screen.getByRole('combobox', { name: m['dashboard.providers.editor.validate_model']() });
  expect(picker).toHaveTextContent('a');
  fireEvent.click(within(screen.getByTestId('model-row-a')).getByRole('checkbox'));
  await waitFor(() => expect(picker).toHaveTextContent('b'));
  expect(screen.queryByTestId('exposure-route-a')).toBeNull();
  fireEvent.click(picker);
  expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['b']);
  fireEvent.click(screen.getByRole('option', { name: 'b' }));

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.editor.validate_action']() }));
  await waitFor(() =>
    expect(mocks.testDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'b',
        draft: expect.objectContaining({ syncModels: true, excludedModels: ['a'] }),
      }),
    ),
  );
  const save = within(screen.getByTestId('editor-footer')).getByRole('button', {
    name: m['dashboard.providers.editor.footer_save'](),
  });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  const input = mocks.update.mock.calls[0]?.[0] as { body: unknown };
  expect(input.body).toMatchObject({ syncModels: true, models: [], excludedModels: ['a'] });
  expect(ProviderMutationBodySchema.safeParse(input.body).success).toBe(true);
  expect(mocks.editView).not.toHaveBeenCalled();
  queryClient.clear();
});

test('changing a create draft from API to AI SDK clears sync state and the discovered catalog', async () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const props = {
    mode: ProviderFormMode.Create,
    kind: ProviderKind.Api,
    initial: {
      id: 'provider',
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.example/v1',
      models: ['old'],
    },
    onKindChange: rs.fn(),
    onSessionIdChange: rs.fn(),
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProviderEditorPage {...props} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId('models-sync-switch'));
  await screen.findByTestId('model-row-b');
  expect(screen.getByTestId('models-sync-switch')).toBeChecked();
  expect(mocks.catalog).toHaveBeenCalledTimes(1);
  fireEvent.click(within(screen.getByTestId('model-row-a')).getByRole('checkbox'));

  fireEvent.click(screen.getByRole('radio', { name: /AI SDK/u }));
  expect(props.onKindChange).toHaveBeenCalledWith(ProviderKind.AiSdk);
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <ProviderEditorPage {...props} kind={ProviderKind.AiSdk} />
    </QueryClientProvider>,
  );

  expect(screen.getByTestId('models-sync-switch')).not.toBeChecked();
  expect(screen.queryAllByTestId(/^model-row-/u)).toHaveLength(0);
  expect(screen.getByTestId('models-empty')).toBeInTheDocument();
  const modelInput = screen.getByLabelText(m['dashboard.providers.editor.models_manual_add']());
  fireEvent.change(modelInput, { target: { value: 'sdk-model' } });
  fireEvent.keyDown(modelInput, { key: 'Enter' });
  const packageInput = within(screen.getByTestId('provider-form-field-packageName')).getByRole('combobox');
  fireEvent.change(packageInput, { target: { value: '@example/custom-sdk' } });
  fireEvent.blur(packageInput);

  const save = within(screen.getByTestId('editor-footer')).getByRole('button', {
    name: m['dashboard.providers.editor.footer_save'](),
  });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  const body = mocks.create.mock.calls[0]?.[0];
  expect(body).toMatchObject({ kind: 'ai-sdk', models: ['sdk-model'] });
  expect(body).not.toHaveProperty('syncModels');
  expect(body).not.toHaveProperty('excludedModels');
  expect(ProviderMutationBodySchema.safeParse(body).success).toBe(true);
  expect(mocks.catalog).toHaveBeenCalledTimes(1);
  queryClient.clear();
});

test('a saved synced Provider without a first discovery remains saveable', async () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProviderEditorPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.Api}
        providerId="provider"
        initial={{
          id: 'provider',
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: 'https://api.example/v1',
          syncModels: true,
        }}
        sync={{ models: [] }}
        onSessionIdChange={rs.fn()}
      />
    </QueryClientProvider>,
  );

  const save = within(screen.getByTestId('editor-footer')).getByRole('button', {
    name: m['dashboard.providers.editor.footer_save'](),
  });
  expect(save).toBeEnabled();
  expect(screen.getByTestId('models-sync-switch')).toBeChecked();
  expect(screen.getByTestId('models-sync-refreshed')).toHaveTextContent(
    m['dashboard.providers.form.models_sync_never'](),
  );
  expect(screen.getByTestId('models-catalog-load')).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  const input = mocks.update.mock.calls[0]?.[0] as { body: unknown };
  expect(input.body).toMatchObject({ syncModels: true, models: [], excludedModels: [] });
  expect(ProviderMutationBodySchema.safeParse(input.body).success).toBe(true);
  expect(mocks.catalog).not.toHaveBeenCalled();
  expect(mocks.editView).not.toHaveBeenCalled();
  queryClient.clear();
});

test('pulling a manual catalog does not expose or make unchecked models testable', async () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProviderEditorPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.Api}
        providerId="provider"
        initial={{
          id: 'provider',
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: 'https://api.example/v1',
          models: [],
        }}
        onSessionIdChange={rs.fn()}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId('models-catalog-load'));
  await screen.findByTestId('model-row-b');

  expect(within(screen.getByTestId('model-row-b')).getByRole('checkbox')).not.toBeChecked();
  expect(screen.queryByTestId('exposure-route-b')).toBeNull();
  expect(screen.queryByRole('button', { name: m['dashboard.providers.editor.validate_action']() })).toBeNull();
  expect(
    within(screen.getByTestId('editor-footer')).getByRole('button', {
      name: m['dashboard.providers.editor.footer_save'](),
    }),
  ).toBeDisabled();
  queryClient.clear();
});
