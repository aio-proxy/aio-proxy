import type { DashboardSettingsView } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { SettingsPage } from '.';
import { SettingsForm } from '../../components/settings-form';

const mocks = rs.hoisted(() => ({
  mutate: rs.fn(),
  useSettingsMutation: rs.fn(),
  useSettingsQuery: rs.fn(),
}));

rs.mock('../../hooks/use-settings-query', () => ({
  useSettingsQuery: () => mocks.useSettingsQuery(),
}));

rs.mock('../../hooks/use-settings-mutation', () => ({
  useSettingsMutation: () => mocks.useSettingsMutation(),
}));

rs.mock('../../hooks/use-reload-mutation', () => ({
  useReloadMutation: () => ({ isPending: false, mutate: rs.fn() }),
}));

const settings: DashboardSettingsView = {
  apiKeys: [{ key: '****', label: 'ci' }, { key: '****' }],
  apiKeysRevision: 'sha256:current',
  hasPassword: true,
  host: '127.0.0.1',
  logging: { enabled: true, level: 'info', retentionDays: 3 },
  port: 9317,
  proxy: '****',
  retryAfterCapMs: 30_000,
};

const prepareMocks = (restartRequired?: boolean) => {
  mocks.mutate.mockReset();
  mocks.useSettingsQuery.mockReturnValue({ data: settings, isError: false, isLoading: false });
  mocks.useSettingsMutation.mockReturnValue({
    data: restartRequired === undefined ? undefined : { ok: true, restartRequired, settings },
    isError: false,
    isPending: false,
    mutate: mocks.mutate,
  });
};

const renderPage = (restartRequired?: boolean) => {
  prepareMocks(restartRequired);
  return render(<SettingsPage />);
};

test('renders service/access/network before logs/retries and keeps the logging Switch in its group header', () => {
  renderPage();

  const service = screen.getByRole('heading', {
    level: 2,
    name: /Service, access & network|服务、访问与网络|服務、存取與網路/u,
  });
  const logs = screen.getByRole('heading', { level: 2, name: /Logs & retries|日志与重试|日誌與重試/u });
  expect(service.compareDocumentPosition(logs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const logging = screen.getByRole('switch', { name: /Request logging|请求日志|請求日誌/u });
  const header = logging.closest('[data-slot="card-header"]');
  expect(header).not.toBeNull();
  expect(within(header as HTMLElement).getByRole('heading', { level: 2 })).toBe(logs);
});

test('sets a new dashboard password from a writable field', () => {
  renderPage();

  const password = screen.getByLabelText(/Dashboard password|控制台密码|控制台密碼/u);
  expect(password).toHaveAttribute('type', 'password');
  expect(password).not.toHaveAttribute('readonly');

  fireEvent.change(password, { target: { value: 'correct horse battery' } });
  fireEvent.click(screen.getByRole('button', { name: /Set password|设置密码|設定密碼/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ password: 'correct horse battery' }, { onSuccess: expect.any(Function) });
});

test('holds the password draft until the write succeeds and clears it only then', () => {
  renderPage();

  const password = screen.getByLabelText(/Dashboard password|控制台密码|控制台密碼/u);
  fireEvent.change(password, { target: { value: 'correct horse battery' } });
  fireEvent.click(screen.getByRole('button', { name: /Set password|设置密码|設定密碼/u }));

  // A rejected write leaves no copy of the secret anywhere, so the field must still hold it.
  expect(password).toHaveValue('correct horse battery');

  const [, options] = mocks.mutate.mock.calls[0] as [unknown, { readonly onSuccess: () => void }];
  act(() => options.onSuccess());

  expect(password).toHaveValue('');
});

test('refuses to submit a password below the minimum length', () => {
  renderPage();

  const password = screen.getByLabelText(/Dashboard password|控制台密码|控制台密碼/u);
  fireEvent.change(password, { target: { value: 'short12' } });
  fireEvent.click(screen.getByRole('button', { name: /Set password|设置密码|設定密碼/u }));

  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.getByText(/at least 8 characters|至少需要 8|8 文字以上|8자 이상/u)).toBeInTheDocument();
});

test('clears a configured password', () => {
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: /Clear password|清除密码|清除密碼/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ password: null }, { onSuccess: expect.any(Function) });
});

test('writes a routine logging change exactly once', () => {
  renderPage();

  fireEvent.click(screen.getByRole('switch', { name: /Request logging|请求日志|請求日誌/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ logging: { enabled: false } });
});

test('clears a configured proxy only after the masked value is deliberately removed', () => {
  renderPage();

  const proxy = screen.getByLabelText(/Default HTTP\(S\) proxy|默认 HTTP\(S\) 代理|預設 HTTP\(S\) 代理/u);
  expect(proxy).toHaveValue('****');

  fireEvent.change(proxy, { target: { value: '' } });
  fireEvent.blur(proxy);

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ proxy: null });
});

test('remasks a saved proxy and does not save it again on blur', () => {
  prepareMocks();
  const form = render(<SettingsForm settings={settings} />);
  const proxy = screen.getByLabelText(/Default HTTP\(S\) proxy|默认 HTTP\(S\) 代理|預設 HTTP\(S\) 代理/u);

  fireEvent.change(proxy, { target: { value: 'https://proxy.example:8080' } });
  fireEvent.blur(proxy);
  expect(mocks.mutate).toHaveBeenCalledTimes(1);

  mocks.useSettingsMutation.mockReturnValue({
    data: { ok: true, restartRequired: false, settings },
    isError: false,
    isPending: false,
    mutate: mocks.mutate,
  });
  form.rerender(<SettingsForm settings={settings} />);

  expect(proxy).toHaveValue('****');
  fireEvent.blur(proxy);
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
});

test('confirms a host change before writing it', () => {
  renderPage();

  const host = screen.getByRole('textbox', { name: /Listen host|监听主机|監聽主機/u });
  fireEvent.change(host, { target: { value: 'localhost' } });
  fireEvent.blur(host);

  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Save change|保存更改|儲存變更/u }));
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ host: 'localhost' });
});

test('confirms a port change before writing it', () => {
  renderPage();

  const port = screen.getByRole('spinbutton', { name: /Port|端口|連接埠/u });
  fireEvent.change(port, { target: { value: '9400' } });
  fireEvent.blur(port);

  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Save change|保存更改|儲存變更/u }));
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ port: 9400 });
});

test('restores authoritative values after a rejected mutation', () => {
  prepareMocks();
  const form = render(<SettingsForm settings={settings} />);
  const port = screen.getByRole('spinbutton', { name: /Port|端口|連接埠/u });
  fireEvent.change(port, { target: { value: '9400' } });
  fireEvent.blur(port);
  fireEvent.click(screen.getByRole('button', { name: /Save change|保存更改|儲存變更/u }));

  mocks.useSettingsMutation.mockReturnValue({
    data: undefined,
    isError: true,
    isPending: false,
    mutate: mocks.mutate,
  });
  form.rerender(<SettingsForm settings={settings} />);

  expect(port).toHaveValue(9317);
});

test('shows restart guidance only when the server reports restartRequired', () => {
  const restart = renderPage(true);
  expect(screen.getByRole('status')).toHaveTextContent(/Restart aio-proxy|重启 aio-proxy|重新啟動 aio-proxy/u);

  restart.unmount();
  renderPage(false);
  expect(screen.getByRole('status')).toHaveTextContent(/Settings saved|设置已保存|設定已儲存/u);
  expect(screen.getByRole('status')).not.toHaveTextContent(/Restart aio-proxy|重启 aio-proxy|重新啟動 aio-proxy/u);
});

test('lists stored API keys masked and retains them by index when saving', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  expect(within(group).getAllByDisplayValue('****')).toHaveLength(2);

  fireEvent.change(within(group).getAllByLabelText(/Label|标签|標籤|ラベル|라벨/u)[0] as HTMLElement, {
    target: { value: 'ci-renamed' },
  });
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ retain: 0, label: 'ci-renamed' }, { retain: 1 }],
    apiKeysRevision: settings.apiKeysRevision,
  });
});

test('adds a new API key and sends it in plaintext exactly once', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(within(group).getByRole('button', { name: /Add key|添加密钥|新增金鑰|キーを追加|키 추가/u }));

  const values = within(group).getAllByLabelText(/^Key$|^密钥$|^金鑰$|^キー$|^키$/u);
  fireEvent.change(values[values.length - 1] as HTMLElement, { target: { value: 'sk-added' } });
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ retain: 0, label: 'ci' }, { retain: 1 }, { key: 'sk-added' }],
    apiKeysRevision: settings.apiKeysRevision,
  });
});

test('generates a usable key for a new row without asking the server for one', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(within(group).getByRole('button', { name: /Add key|添加密钥|新增金鑰|キーを追加|키 추가/u }));
  fireEvent.click(
    within(group).getByRole('button', { name: /Generate a key|随机生成密钥|隨機產生金鑰|キーを生成|키 생성/u }),
  );

  const values = within(group).getAllByLabelText(/^Key$|^密钥$|^金鑰$|^キー$|^키$/u);
  const generated = (values[values.length - 1] as HTMLInputElement).value;
  // A key too short or without enough entropy is worse than no key: it is a guessable credential.
  expect(generated).toMatch(/^sk-[0-9a-f]{48}$/u);

  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ retain: 0, label: 'ci' }, { retain: 1 }, { key: generated }],
    apiKeysRevision: settings.apiKeysRevision,
  });
});

test('puts the required key before the optional label in each row', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  const key = within(group).getAllByLabelText(/^Key$|^密钥$|^金鑰$|^キー$|^키$/u)[0] as HTMLElement;
  const label = within(group).getAllByLabelText(/Label|标签|標籤|ラベル|라벨/u)[0] as HTMLElement;

  expect(key.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('removes a stored API key', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(within(group).getByRole('button', { name: /Remove key ci|移除密钥 ci|移除金鑰 ci|キー ci|키 ci/u }));
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ retain: 1 }],
    apiKeysRevision: settings.apiKeysRevision,
  });
});

test('resets API key rows when a reload replaces the stored keys', () => {
  const { rerender } = renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.change(within(group).getAllByLabelText(/Label|标签|標籤|ラベル|라벨/u)[0] as HTMLElement, {
    target: { value: 'stale-draft' },
  });

  mocks.useSettingsQuery.mockReturnValue({
    data: { ...settings, apiKeys: [{ key: '****', label: 'reloaded' }], apiKeysRevision: 'sha256:reloaded' },
    isError: false,
    isLoading: false,
  });
  rerender(<SettingsPage />);

  const reloaded = screen.getByTestId('settings-group-api-keys');
  expect(within(reloaded).getAllByDisplayValue('****')).toHaveLength(1);
  expect(within(reloaded).queryByDisplayValue('stale-draft')).toBeNull();

  fireEvent.click(within(reloaded).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ retain: 0, label: 'reloaded' }],
    apiKeysRevision: 'sha256:reloaded',
  });
});

test('keeps an in-progress key draft when an unrelated save refreshes the settings object', () => {
  const { rerender } = renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.change(within(group).getAllByLabelText(/Label|标签|標籤|ラベル|라벨/u)[0] as HTMLElement, {
    target: { value: 'in-progress' },
  });

  // A password write re-fetches settings; the authored keys are untouched, so the digest holds.
  mocks.useSettingsQuery.mockReturnValue({
    data: { ...settings, apiKeys: [...settings.apiKeys] },
    isError: false,
    isLoading: false,
  });
  rerender(<SettingsPage />);

  const refreshed = screen.getByTestId('settings-group-api-keys');
  expect(within(refreshed).getByDisplayValue('in-progress')).toBeInTheDocument();
});
