/* oxlint-disable max-lines */
import {
  ProviderKind,
  ProviderProtocol,
  type DashboardPluginEditView,
  type DashboardPluginSummary,
  type DashboardProviderSummary,
} from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PluginRequestError } from '../../services/plugins-service';
import { PluginsPage } from './plugins-page';

const mocks = rs.hoisted(() => ({
  editView: undefined as DashboardPluginEditView | undefined,
  install: { error: null as Error | null, isPending: false, mutate: rs.fn(), reset: rs.fn() },
  options: { error: null as Error | null, isPending: false, mutate: rs.fn(), reset: rs.fn() },
  plugins: { data: { plugins: [] as DashboardPluginSummary[] }, isError: false, isLoading: false },
  uninstall: { error: null as Error | null, isPending: false, mutate: rs.fn(), reset: rs.fn() },
}));

rs.mock('../../hooks/use-plugins-query', () => ({
  usePluginEditViewQuery: (packageName: string | null) => ({
    data: packageName === null ? undefined : mocks.editView,
    isError: false,
    isLoading: false,
  }),
  usePluginsQuery: () => mocks.plugins,
}));

rs.mock('../../hooks/use-plugin-mutations', () => ({
  usePluginInstallMutation: () => mocks.install,
  usePluginOptionsMutation: () => mocks.options,
  usePluginUninstallMutation: () => mocks.uninstall,
}));

const plugin = (values: Partial<DashboardPluginSummary> = {}): DashboardPluginSummary => ({
  builtin: false,
  enabled: true,
  hasOptions: false,
  packageName: '@example/plugin',
  state: { status: 'ready' },
  version: '1.2.3',
  ...values,
});

// Base UI checkboxes activate by dispatching a synthetic click onto their hidden input. Under
// happy-dom that click also reaches the wrapping <label>, which forwards a second click back to the
// input, so a keyboard Space (or a click on the checkbox itself) toggles twice and nets out unchanged.
// Clicking the label is the one gesture that produces exactly one toggle here.
const toggleCheckbox = (checkbox: HTMLElement) => {
  const labelId = checkbox.getAttribute('aria-labelledby');
  const label = labelId === null ? null : document.getElementById(labelId);
  if (label === null) throw new Error('checkbox is not associated with a label element');
  fireEvent.click(label);
};

afterEach(() => {
  mocks.editView = undefined;
  mocks.plugins.data.plugins = [];
  mocks.plugins.isError = false;
  for (const mutation of [mocks.install, mocks.options, mocks.uninstall]) {
    mutation.error = null;
    mutation.isPending = false;
    mutation.mutate.mockReset();
    mutation.reset.mockReset();
    mutation.reset.mockImplementation(() => {
      mutation.error = null;
    });
  }
});

test('keeps Add Plugin in the page header and confirms the exact request after the typed trust challenge', async () => {
  mocks.install.mutate.mockImplementation((input, callbacks) => {
    if (input.confirmed !== true) {
      const error = new PluginRequestError('confirmation_required', 400);
      mocks.install.error = error;
      callbacks.onError(error);
    }
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );

  const add = screen.getByRole('button', { name: /Add Plugin|添加插件|新增外掛/u });
  expect(add.closest('header')).not.toBeNull();
  fireEvent.click(add);

  fireEvent.change(screen.getByLabelText(/Package name|包名称|套件名稱/u), {
    target: { value: '@example/new-plugin' },
  });
  const install = screen.getByRole('button', { name: /Install Plugin|安装插件|安裝外掛/u });
  expect(install).toBeEnabled();
  fireEvent.click(install);

  await waitFor(() => {
    expect(mocks.install.mutate).toHaveBeenNthCalledWith(1, { packageName: '@example/new-plugin' }, expect.any(Object));
  });

  const trust = screen.getByRole('checkbox', { name: /trust|信任/u });
  expect(install).toBeDisabled();
  toggleCheckbox(trust);
  expect(trust).toBeChecked();
  await waitFor(() => expect(install).toBeEnabled());
  fireEvent.click(install);

  await waitFor(() => {
    expect(mocks.install.mutate).toHaveBeenNthCalledWith(
      2,
      { confirmed: true, packageName: '@example/new-plugin' },
      expect.any(Object),
    );
  });
});

test('clears challenged trust when the package, registry, or drawer lifecycle changes', async () => {
  mocks.install.mutate.mockImplementation((input, callbacks) => {
    if (input.confirmed !== true) {
      const error = new PluginRequestError('confirmation_required', 400);
      mocks.install.error = error;
      callbacks.onError(error);
    }
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: /Add Plugin|添加插件|新增外掛/u }));
  const packageName = screen.getByLabelText(/Package name|包名称|套件名稱/u);
  const registry = screen.getByLabelText(/Registry|注册表|登錄檔/u);
  const install = screen.getByRole('button', { name: /Install Plugin|安装插件|安裝外掛/u });

  fireEvent.change(packageName, { target: { value: '@example/first-plugin' } });
  fireEvent.click(install);
  let trust = await screen.findByRole('checkbox', { name: /trust|信任/u });
  fireEvent.click(trust);

  fireEvent.change(packageName, { target: { value: '@example/second-plugin' } });
  expect(screen.queryByRole('checkbox', { name: /trust|信任/u })).toBeNull();
  await waitFor(() => expect(install).toBeEnabled());
  fireEvent.click(install);
  await waitFor(() => {
    expect(mocks.install.mutate).toHaveBeenLastCalledWith(
      { packageName: '@example/second-plugin' },
      expect.any(Object),
    );
  });

  trust = await screen.findByRole('checkbox', { name: /trust|信任/u });
  fireEvent.click(trust);
  fireEvent.change(registry, { target: { value: 'https://registry.example.com' } });
  expect(screen.queryByRole('checkbox', { name: /trust|信任/u })).toBeNull();
  await waitFor(() => expect(install).toBeEnabled());
  fireEvent.click(install);
  await waitFor(() => {
    expect(mocks.install.mutate).toHaveBeenLastCalledWith(
      { packageName: '@example/second-plugin', registry: 'https://registry.example.com' },
      expect.any(Object),
    );
  });

  await screen.findByRole('checkbox', { name: /trust|信任/u });
  fireEvent.click(screen.getByRole('button', { name: /Cancel|取消/u }));
  fireEvent.click(screen.getByRole('button', { name: /Add Plugin|添加插件|新增外掛/u }));
  expect(screen.getByLabelText(/Package name|包名称|套件名稱/u)).toHaveValue('');
  expect(screen.queryByRole('checkbox', { name: /trust|信任/u })).toBeNull();
});

test('does not offer uninstall for a built-in Plugin', () => {
  mocks.plugins.data.plugins = [plugin({ builtin: true, packageName: '@aio-proxy/plugin-openai' })];

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );

  const row = within(screen.getByTestId('plugin-row-@aio-proxy/plugin-openai'));
  expect(row.getByText(/Built-in|内置|內建/u)).toBeInTheDocument();
  expect(row.queryByRole('button', { name: /Uninstall|卸载|解除安裝/u })).toBeNull();
});

test('requires confirmation before uninstalling a third-party Plugin', () => {
  mocks.plugins.data.plugins = [plugin()];

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Uninstall|卸载|解除安裝/u }));

  expect(screen.getByRole('alertdialog')).toHaveTextContent('@example/plugin');
  expect(mocks.uninstall.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Confirm uninstall|确认卸载|確認解除安裝/u }));
  expect(mocks.uninstall.mutate).toHaveBeenCalledWith('@example/plugin', expect.any(Object));
});

test('loads the safe options edit-view without rendering a stored secret and submits explicit changes', async () => {
  mocks.plugins.data.plugins = [plugin({ hasOptions: true })];
  mocks.editView = {
    packageName: '@example/plugin',
    revision: 'sha256:current',
    publicValues: { endpoint: 'https://api.example.com' },
    form: [
      { key: 'endpoint', label: 'Endpoint', type: 'text' },
      { configured: true, key: 'token', label: 'Token', type: 'secret' },
      { configured: true, key: 'legacyToken', label: 'Legacy token', type: 'secret' },
    ],
  };

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Options|选项|選項/u }));

  await waitFor(() => expect(screen.getByLabelText('Endpoint')).toHaveValue('https://api.example.com'));
  expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
  expect(screen.getByLabelText('Token')).toHaveValue('');
  expect(screen.queryByDisplayValue('stored-secret')).toBeNull();
  expect(screen.getAllByText(/Secret configured|密钥已配置|密鑰已設定/u)).toHaveLength(2);

  fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://eu.example.com' } });
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'replacement' } });
  const clearLegacy = screen.getByRole('checkbox', { name: /Clear Legacy token|清除 Legacy token/u });
  toggleCheckbox(clearLegacy);
  expect(clearLegacy).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: /Save options|保存选项|儲存選項/u }));

  await waitFor(() => {
    expect(mocks.options.mutate).toHaveBeenCalledWith(
      {
        clearSecretKeys: ['legacyToken'],
        packageName: '@example/plugin',
        publicValues: { endpoint: 'https://eu.example.com' },
        revision: 'sha256:current',
        secretValues: { token: 'replacement' },
      },
      expect.any(Object),
    );
  });
});

test('clears unsaved replacement secrets and mutation errors before options can reopen', async () => {
  mocks.plugins.data.plugins = [plugin({ hasOptions: true })];
  mocks.editView = {
    packageName: '@example/plugin',
    revision: 'sha256:current',
    publicValues: {},
    form: [{ configured: true, key: 'token', label: 'Token', type: 'secret' }],
  };
  mocks.options.error = new PluginRequestError('stale_revision', 409);
  mocks.options.reset.mockImplementation(() => {
    mocks.options.error = null;
  });

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );
  const options = screen.getByRole('button', { name: /Options|选项|選項/u });
  fireEvent.click(options);
  const token = await screen.findByLabelText('Token');
  fireEvent.change(token, { target: { value: 'unsaved-replacement' } });
  expect(token).toHaveValue('unsaved-replacement');
  expect(screen.getByRole('alert')).toBeInTheDocument();

  const cancel = screen.getByRole('button', { name: /Cancel|取消/u });
  act(() => {
    cancel.click();
    options.click();
  });

  expect(screen.getByLabelText('Token')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: /Cancel|取消/u }));
  fireEvent.click(options);
  expect(mocks.options.reset).toHaveBeenCalled();
  expect(mocks.options.error).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

test.each([
  { publicValues: {}, selectedLabel: 'Fixed' },
  { publicValues: { userAgentPolicy: 'preserve' }, selectedLabel: 'Preserve' },
])('shows option labels for $selectedLabel without persisting defaults', async ({ publicValues, selectedLabel }) => {
  mocks.plugins.data.plugins = [plugin({ hasOptions: true })];
  mocks.editView = {
    packageName: '@example/plugin',
    revision: 'sha256:current',
    publicValues,
    form: [
      { defaultValue: 'codex-tui/{{latest_codex_rs_version}}', key: 'userAgent', label: 'User-Agent', type: 'text' },
      {
        defaultValue: 'fixed',
        key: 'userAgentPolicy',
        label: 'User-Agent policy',
        options: [
          { label: 'Fixed', value: 'fixed' },
          { label: 'Preserve', value: 'preserve' },
        ],
        type: 'select',
      },
    ],
  };

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Options|选项|選項/u }));

  expect(await screen.findByLabelText('User-Agent')).toHaveValue('codex-tui/{{latest_codex_rs_version}}');
  expect(screen.getByRole('combobox', { name: 'User-Agent policy' })).toHaveTextContent(selectedLabel);
  fireEvent.click(screen.getByRole('button', { name: /Save options|保存选项|儲存選項/u }));

  await waitFor(() => {
    expect(mocks.options.mutate).toHaveBeenCalledWith(expect.objectContaining({ publicValues }), expect.any(Object));
  });
});

test('uses effective defaults when evaluating conditional option fields', async () => {
  mocks.plugins.data.plugins = [plugin({ hasOptions: true })];
  mocks.editView = {
    packageName: '@example/plugin',
    revision: 'sha256:current',
    publicValues: {},
    form: [
      {
        defaultValue: true,
        key: 'advanced',
        label: 'Advanced',
        type: 'boolean',
      },
      {
        key: 'mode',
        label: 'Mode',
        type: 'text',
        when: { equals: true, key: 'advanced' },
      },
    ],
  };

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Options|选项|選項/u }));

  expect(await screen.findByLabelText('Mode')).toBeInTheDocument();
});

test('associates descriptions with boolean, select, JSON, and secret option controls', async () => {
  mocks.plugins.data.plugins = [plugin({ hasOptions: true })];
  mocks.editView = {
    packageName: '@example/plugin',
    revision: 'sha256:current',
    publicValues: {},
    form: [
      {
        description: 'Enables advanced options',
        key: 'advanced',
        label: 'Advanced',
        type: 'boolean',
      },
      {
        description: 'Select the operating mode',
        key: 'mode',
        label: 'Mode',
        options: [{ label: 'Fast', value: 'fast' }],
        type: 'select',
      },
      {
        description: 'Enter structured settings',
        key: 'settings',
        label: 'Settings',
        type: 'json',
      },
      {
        configured: false,
        description: 'Enter a replacement token',
        key: 'token',
        label: 'Token',
        type: 'secret',
      },
    ],
  };

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Options|选项|選項/u }));

  expect(await screen.findByRole('switch', { name: 'Advanced' })).toHaveAccessibleDescription(
    'Enables advanced options',
  );
  expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveAccessibleDescription('Select the operating mode');
  expect(screen.getByLabelText('Settings')).toHaveAccessibleDescription('Enter structured settings');
  expect(screen.getByLabelText('Token')).toHaveAccessibleDescription('Enter a replacement token');
});

test('keeps cleared public option values serializable', async () => {
  mocks.plugins.data.plugins = [plugin({ hasOptions: true })];
  mocks.editView = {
    packageName: '@example/plugin',
    revision: 'sha256:current',
    publicValues: { retries: 3 },
    form: [{ key: 'retries', label: 'Retries', type: 'number' }],
  };

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Options|选项|選項/u }));
  await waitFor(() => expect(screen.getByLabelText('Retries')).toHaveValue(3));
  fireEvent.change(screen.getByLabelText('Retries'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /Save options|保存选项|儲存選項/u }));

  await waitFor(() => {
    expect(mocks.options.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ publicValues: {} }),
      expect.any(Object),
    );
  });
});

test('keeps uninstall open and lists dependent Provider IDs after a refusal', () => {
  mocks.plugins.data.plugins = [plugin()];
  mocks.uninstall.mutate.mockImplementation((_packageName, callbacks) => {
    callbacks.onError(new PluginRequestError('dependent_providers', 409, ['primary', 'fallback']));
  });

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Uninstall|卸载|解除安裝/u }));
  fireEvent.click(screen.getByRole('button', { name: /Confirm uninstall|确认卸载|確認解除安裝/u }));

  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toBeInTheDocument();
  expect(dialog).toHaveTextContent('primary');
  expect(dialog).toHaveTextContent('fallback');
});

const evaluationProvider = (values: Partial<DashboardProviderSummary> = {}): DashboardProviderSummary => ({
  id: 'system-one-local',
  name: 'Local evaluator',
  enabled: true,
  kind: ProviderKind.Api,
  protocols: [ProviderProtocol.TypeSafeSystemOne],
  clientModels: ['local-model'],
  state: { status: 'ready' },
  passthrough: false,
  last_status: '',
  last_latency: null,
  hasQuota: false,
  canRefreshCredential: false,
  ...values,
});

const openGuardianOptions = (publicValues: DashboardPluginEditView['publicValues'] = {}) => {
  mocks.plugins.data.plugins = [plugin({ hasOptions: true })];
  mocks.editView = {
    packageName: '@example/plugin',
    revision: 'sha256:guardian',
    publicValues,
    form: [
      {
        type: 'select',
        key: 'strategy',
        label: 'Guardian review strategy',
        defaultValue: 'default',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'systemOne', label: 'System One' },
          { value: 'systemOneReviewDenied', label: 'System One with review' },
        ],
      },
      {
        type: 'provider',
        key: 'target',
        label: 'Evaluation Provider',
        description: 'Approval context is sent to the selected Provider.',
        protocols: [ProviderProtocol.TypeSafeSystemOne],
        when: { key: 'strategy', notEquals: 'default' },
      },
      {
        type: 'provider-model',
        key: 'model',
        providerKey: 'target',
        label: 'Model ID',
        when: { key: 'strategy', notEquals: 'default' },
      },
    ],
  };
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['providers'], {
    providers: [
      evaluationProvider(),
      evaluationProvider({
        id: 'sdk',
        name: 'Unknown support',
        kind: ProviderKind.AiSdk,
        protocols: [],
        clientModels: ['sdk-model'],
      }),
      evaluationProvider({ id: 'incompatible', protocols: [ProviderProtocol.OpenAICompatible] }),
      evaluationProvider({ id: 'disabled', enabled: false }),
    ],
    routingRevision: 'test',
  });
  render(
    <QueryClientProvider client={client}>
      <PluginsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Options|选项|選項/u }));
};

const choose = async (label: string, option: string) => {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.keyDown(await screen.findByRole('option', { name: option }), { key: 'Enter' });
};

test.each(['System One', 'System One with review'])(
  'shows generic evaluation controls for %s and persists exact IDs',
  async (strategy) => {
    openGuardianOptions();
    expect(screen.queryByLabelText('Evaluation Provider')).toBeNull();
    expect(screen.queryByLabelText('Model ID')).toBeNull();
    await choose('Guardian review strategy', strategy);
    expect(screen.getByLabelText('Evaluation Provider')).toHaveAccessibleDescription(
      expect.stringContaining('Approval context'),
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Evaluation Provider' }));
    expect(await screen.findByRole('option', { name: 'Local evaluator (system-one-local)' })).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Unknown support (sdk)' })).toBeEnabled();
    expect(screen.queryByRole('option', { name: /incompatible/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /disabled/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('option', { name: 'Local evaluator (system-one-local)' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('combobox', { name: 'Model ID' }));
    fireEvent.keyDown(await screen.findByRole('option', { name: 'local-model' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Save options|保存选项|儲存選項/u }));
    await waitFor(() =>
      expect(mocks.options.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          publicValues: {
            strategy: strategy === 'System One' ? 'systemOne' : 'systemOneReviewDenied',
            target: 'system-one-local',
            model: 'local-model',
          },
        }),
        expect.any(Object),
      ),
    );
    await choose('Evaluation Provider', 'Unknown support (sdk)');
    expect(screen.getByRole('combobox', { name: 'Model ID' })).not.toHaveTextContent('local-model');
  },
);

test.each(['deleted', 'disabled', 'incompatible', ''])(
  'blocks invalid saved evaluation Provider %s until default mode',
  async (target) => {
    openGuardianOptions({ strategy: 'systemOne', target, model: 'local-model' });
    const provider = screen.getByLabelText('Evaluation Provider');
    if (target !== '') expect(provider).toHaveTextContent(target);
    expect(provider).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    const save = screen.getByRole('button', { name: /Save options|保存选项|儲存選項/u });
    fireEvent.submit(save.closest('form')!);
    await act(async () => {});
    expect(mocks.options.mutate).not.toHaveBeenCalled();
    await choose('Guardian review strategy', 'Default');
    fireEvent.click(save);
    await waitFor(() => expect(mocks.options.mutate).toHaveBeenCalled());
  },
);

test('requires a routed model and allows correcting an invalid saved Provider', async () => {
  openGuardianOptions({ strategy: 'systemOne', target: 'deleted', model: 'old-model' });
  await choose('Evaluation Provider', 'Local evaluator (system-one-local)');
  expect(screen.getByLabelText('Model ID')).not.toHaveTextContent('old-model');
  const save = screen.getByRole('button', { name: /Save options|保存选项|儲存選項/u });
  fireEvent.submit(save.closest('form')!);
  await act(async () => {});
  expect(mocks.options.mutate).not.toHaveBeenCalled();
  await choose('Model ID', 'local-model');
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() =>
    expect(mocks.options.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        publicValues: { strategy: 'systemOne', target: 'system-one-local', model: 'local-model' },
      }),
      expect.any(Object),
    ),
  );
});
