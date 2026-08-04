import type { DashboardPluginEditView, DashboardPluginSummary } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PluginRequestError } from '../../services/plugins-service';
import { PluginsPage } from './plugins-page';

const mocks = rs.hoisted(() => ({
  editView: undefined as DashboardPluginEditView | undefined,
  install: { error: null as Error | null, isPending: false, mutate: rs.fn() },
  options: { error: null as Error | null, isPending: false, mutate: rs.fn() },
  plugins: { data: { plugins: [] as DashboardPluginSummary[] }, isError: false, isLoading: false },
  uninstall: { error: null as Error | null, isPending: false, mutate: rs.fn() },
}));

rs.mock('../../hooks/use-plugins-query', () => ({
  usePluginEditViewQuery: () => ({ data: mocks.editView, isError: false, isLoading: false }),
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

afterEach(() => {
  mocks.editView = undefined;
  mocks.plugins.data.plugins = [];
  mocks.plugins.isError = false;
  for (const mutation of [mocks.install, mocks.options, mocks.uninstall]) {
    mutation.error = null;
    mutation.isPending = false;
    mutation.mutate.mockReset();
  }
});

test('keeps Add Plugin in the page header and gates installation on local-code trust', async () => {
  render(<PluginsPage />);

  const add = screen.getByRole('button', { name: /Add Plugin|添加插件|新增外掛/u });
  expect(add.closest('header')).not.toBeNull();
  fireEvent.click(add);

  fireEvent.change(screen.getByLabelText(/Package name|包名称|套件名稱/u), {
    target: { value: '@example/new-plugin' },
  });
  const install = screen.getByRole('button', { name: /Install Plugin|安装插件|安裝外掛/u });
  expect(install).toBeDisabled();
  expect(mocks.install.mutate).not.toHaveBeenCalled();

  const trust = screen.getByRole('checkbox', { name: /trust|信任/u });
  fireEvent.keyDown(trust, { code: 'Space', key: ' ' });
  fireEvent.keyUp(trust, { code: 'Space', key: ' ' });
  expect(trust).toBeChecked();
  await waitFor(() => expect(install).toBeEnabled());
  fireEvent.click(install);

  await waitFor(() => {
    expect(mocks.install.mutate).toHaveBeenCalledWith(
      { confirmed: true, packageName: '@example/new-plugin' },
      expect.any(Object),
    );
  });
});

test('does not offer uninstall for a built-in Plugin', () => {
  mocks.plugins.data.plugins = [plugin({ builtin: true, packageName: '@aio-proxy/plugin-openai' })];

  render(<PluginsPage />);

  const row = within(screen.getByTestId('plugin-row-@aio-proxy/plugin-openai'));
  expect(row.getByText(/Built-in|内置|內建/u)).toBeInTheDocument();
  expect(row.queryByRole('button', { name: /Uninstall|卸载|解除安裝/u })).toBeNull();
});

test('requires confirmation before uninstalling a third-party Plugin', () => {
  mocks.plugins.data.plugins = [plugin()];

  render(<PluginsPage />);
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

  render(<PluginsPage />);
  fireEvent.click(screen.getByRole('button', { name: /Options|选项|選項/u }));

  await waitFor(() => expect(screen.getByLabelText('Endpoint')).toHaveValue('https://api.example.com'));
  expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
  expect(screen.getByLabelText('Token')).toHaveValue('');
  expect(screen.queryByDisplayValue('stored-secret')).toBeNull();
  expect(screen.getAllByText(/Secret configured|密钥已配置|密鑰已設定/u)).toHaveLength(2);

  fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://eu.example.com' } });
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'replacement' } });
  const clearLegacy = screen.getByRole('checkbox', { name: /Clear Legacy token|清除 Legacy token/u });
  fireEvent.keyDown(clearLegacy, { code: 'Space', key: ' ' });
  fireEvent.keyUp(clearLegacy, { code: 'Space', key: ' ' });
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

test('keeps cleared public option values serializable', async () => {
  mocks.plugins.data.plugins = [plugin({ hasOptions: true })];
  mocks.editView = {
    packageName: '@example/plugin',
    revision: 'sha256:current',
    publicValues: { retries: 3 },
    form: [{ key: 'retries', label: 'Retries', type: 'number' }],
  };

  render(<PluginsPage />);
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

  render(<PluginsPage />);
  fireEvent.click(screen.getByRole('button', { name: /Uninstall|卸载|解除安裝/u }));
  fireEvent.click(screen.getByRole('button', { name: /Confirm uninstall|确认卸载|確認解除安裝/u }));

  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toBeInTheDocument();
  expect(dialog).toHaveTextContent('primary');
  expect(dialog).toHaveTextContent('fallback');
});
