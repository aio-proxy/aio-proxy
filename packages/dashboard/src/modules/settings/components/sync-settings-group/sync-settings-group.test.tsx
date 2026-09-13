import type { SyncBackendView, SyncPreview, SyncStatus } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SyncSettingsGroup } from './sync-settings-group';

const mocks = rs.hoisted(() => ({
  previewMutate: rs.fn(),
  previewMutateAsync: rs.fn(),
  state: {
    status: undefined as SyncStatus | undefined,
    backends: undefined as { readonly backends: readonly SyncBackendView[] } | undefined,
  },
}));

// The router is mounted with basepath '/dashboard', so a real <Link to="/plugins"> resolves there;
// a raw anchor would not.
rs.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={`/dashboard${to}`} {...props} />
  ),
}));

rs.mock('@/hooks/use-sync', () => ({
  useSyncStatus: () => ({ data: mocks.state.status, isLoading: false, isError: false }),
  useSyncBackends: () => ({ data: mocks.state.backends, isLoading: false, isError: false }),
  usePreviewSync: () => ({
    mutate: mocks.previewMutate,
    mutateAsync: mocks.previewMutateAsync,
    isPending: false,
    isError: false,
  }),
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
  mocks.previewMutateAsync.mockReset();
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
  expect(screen.getByRole('link').getAttribute('href')).toBe('/dashboard/plugins');
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

test('hides a backend field until its controlling option matches', () => {
  const conditional: SyncBackendView = {
    ...cloudkit,
    form: [
      {
        type: 'select',
        key: 'mode',
        label: 'Mode',
        options: [
          { value: 'shared', label: 'Shared' },
          { value: 'private', label: 'Private' },
        ],
      },
      {
        type: 'secret',
        key: 'apiToken',
        label: 'API token',
        configured: false,
        when: { key: 'mode', equals: 'private' },
      },
    ],
  };
  renderGroup([conditional], conditional);

  // A discriminated backend schema rejects Connect when it is handed the option for the branch the
  // user did not pick, so the field must not be reachable until its condition holds.
  expect(screen.queryByLabelText(/API token/u)).toBeNull();
  fireEvent.click(screen.getByLabelText(/Mode/u));
  chooseOption(/^Private$/u);
  expect(screen.getByLabelText(/API token/u)).toBeTruthy();

  fireEvent.click(screen.getByLabelText(/Mode/u));
  chooseOption(/^Shared$/u);
  expect(screen.queryByLabelText(/API token/u)).toBeNull();
});

test('does not reopen the preview dialog with a result abandoned by closing it', async () => {
  const preview: SyncPreview = {
    previewId: 'preview-1',
    kind: 'join',
    expiresAt: Date.now() + 10_000,
    retainedSharedPlugins: [],
    rows: [
      {
        objectId: 'object-work',
        logicalKey: 'work',
        kind: 'provider',
        change: 'update',
        local: { limits: { timeout: 1 } },
        cloud: { limits: { timeout: 2 } },
        secretChange: 'none',
        dependencies: [],
        choices: ['local', 'cloud'],
      },
    ],
  };
  let resolveOverrides!: (value: SyncPreview) => void;
  renderGroup([cloudkit], cloudkit);
  // After `renderGroup`, which resets the mutation mocks.
  mocks.previewMutateAsync.mockReturnValue(
    new Promise<SyncPreview>((resolve) => {
      resolveOverrides = resolve;
    }),
  );
  connect();
  const [, handlers] = mocks.previewMutate.mock.calls[0] as [unknown, { onSuccess(next: SyncPreview): void }];
  handlers.onSuccess(preview);

  fireEvent.change(await screen.findByLabelText(/Option path|选项路径/u), { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));
  await waitFor(() => expect(mocks.previewMutateAsync).toHaveBeenCalledTimes(1));
  // Cancel is disabled while the override preview is in flight, so the reachable dismissal is the
  // dialog's own close control.
  fireEvent.click(screen.getByRole('button', { name: /^(Close|关闭)$/u }));
  await waitFor(() => expect(screen.queryByLabelText(/Option path|选项路径/u)).toBeNull());

  resolveOverrides({ ...preview, previewId: 'preview-overrides', kind: 'overrides' });
  // `act` flushes the continuation that would otherwise reopen the dialog with the abandoned result.
  await act(async () => {});
  expect(screen.queryByText(/Review sync changes|审核同步变更/u)).toBeNull();
});
