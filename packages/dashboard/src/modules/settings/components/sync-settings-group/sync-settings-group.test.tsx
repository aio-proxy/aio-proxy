import type { SyncBackendView, SyncStatus } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerPurgePreviewInput, SyncSettingsGroup } from './sync-settings-group';

const mocks = rs.hoisted(() => ({
  previewMutate: rs.fn(),
  state: {
    status: undefined as SyncStatus | undefined,
    backends: undefined as { readonly backends: readonly SyncBackendView[] } | undefined,
  },
}));

rs.mock('@/hooks/use-sync', () => ({
  useSyncStatus: () => ({ data: mocks.state.status, isLoading: false, isError: false }),
  useSyncBackends: () => ({ data: mocks.state.backends, isLoading: false, isError: false }),
  usePreviewSync: () => ({ mutate: mocks.previewMutate, mutateAsync: rs.fn(), isPending: false, isError: false }),
  useDisconnectSync: () => ({ mutate: rs.fn(), isPending: false, isError: false }),
  useRetrySync: () => ({ mutate: rs.fn(), isPending: false, isError: false }),
  useApplySync: () => ({ mutate: rs.fn(), isPending: false, error: null, reset: rs.fn() }),
}));

const archive: SyncBackendView = {
  plugin: '@aio-proxy/plugin-archive',
  capability: 'sync',
  displayName: 'Archive',
  form: [],
};
const cloudkit: SyncBackendView = {
  plugin: '@aio-proxy/plugin-cloudkit',
  capability: 'sync',
  displayName: 'CloudKit',
  form: [
    { type: 'secret', key: 'apiToken', label: 'API token', configured: true },
    {
      type: 'select',
      key: 'retries',
      label: 'Retries',
      options: [
        { value: 1, label: 'Once' },
        { value: 2, label: 'Twice' },
      ],
    },
  ],
};

const status = (backend: SyncBackendView | null): SyncStatus => ({
  state: 'idle',
  backend: backend === null ? null : { plugin: backend.plugin, capability: backend.capability, spaceId: 'space-1' },
  providers: [],
  pendingOperations: 0,
  lastSuccessAt: null,
});

const renderGroup = (backends: readonly SyncBackendView[], connected: SyncBackendView | null) => {
  mocks.previewMutate.mockReset();
  mocks.state.status = status(connected);
  mocks.state.backends = { backends };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncSettingsGroup />
    </QueryClientProvider>,
  );
};

const chooseOption = (name: RegExp) => {
  const option = screen.getByRole('option', { name });
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
};

const connect = () => fireEvent.click(screen.getByRole('button', { name: /^(Connect|连接)$/u }));

test('shows the explicit local plugin action when no backend is installed', () => {
  renderGroup([], null);
  expect(screen.getByTestId('settings-sync-group')).toBeTruthy();
  expect(screen.getByText(/CloudKit is not installed|未安装 CloudKit/u)).toBeTruthy();
});

test('connects the picked backend instead of the first registered one', () => {
  renderGroup([archive, cloudkit], cloudkit);

  const picker = screen.getByLabelText(/Sync backend|同步后端/u);
  expect(picker.textContent).toContain('CloudKit');
  connect();
  expect(mocks.previewMutate).toHaveBeenLastCalledWith(
    { kind: 'connect', plugin: '@aio-proxy/plugin-cloudkit', capability: 'sync', options: { apiToken: undefined } },
    { onSuccess: expect.any(Function) },
  );

  fireEvent.click(picker);
  chooseOption(/^Archive$/u);
  connect();
  expect(mocks.previewMutate).toHaveBeenLastCalledWith(
    { kind: 'connect', plugin: '@aio-proxy/plugin-archive', capability: 'sync', options: {} },
    { onSuccess: expect.any(Function) },
  );
});

test('submits a typed secret and the authored option type', () => {
  renderGroup([cloudkit], cloudkit);

  expect(screen.getByText(/A value is stored|已存储该密钥/u)).toBeTruthy();
  const secret = screen.getByLabelText(/API token/u);
  expect(secret.getAttribute('type')).toBe('password');
  fireEvent.change(secret, { target: { value: 'token-1' } });
  fireEvent.click(screen.getByLabelText(/Retries/u));
  chooseOption(/^Twice$/u);
  connect();

  expect(mocks.previewMutate).toHaveBeenLastCalledWith(
    {
      kind: 'connect',
      plugin: '@aio-proxy/plugin-cloudkit',
      capability: 'sync',
      options: { apiToken: 'token-1', retries: 2 },
    },
    { onSuccess: expect.any(Function) },
  );
});

test('builds provider purge previews from the selected Provider ID', () => {
  expect(providerPurgePreviewInput('work')).toEqual({ kind: 'purge', scope: 'provider', objectId: 'work' });
});
