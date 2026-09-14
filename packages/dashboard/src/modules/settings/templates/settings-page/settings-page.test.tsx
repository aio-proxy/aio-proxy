import type { DashboardSettingsView } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { SettingsPage } from '.';
import { SettingsForm } from '../../components/settings-form';

const mocks = rs.hoisted(() => ({
  mutate: rs.fn(),
  useSettingsMutation: rs.fn(),
  useSettingsQuery: rs.fn(),
}));

rs.mock('@/modules/settings/hooks/use-release-query', () => ({
  useReleaseQuery: () => ({
    data: { current: '1.4.2', outdated: false, managedService: false, update: { status: 'idle' } },
  }),
}));

rs.mock('@/modules/settings/services/release-service', () => ({
  applyReleaseMutationFn: rs.fn(),
  checkLatestReleaseMutationFn: rs.fn(),
  releaseQueryOptions: () => ({
    queryKey: ['release'],
    queryFn: rs.fn().mockResolvedValue({
      current: '1.4.2',
      outdated: false,
      managedService: false,
      update: { status: 'idle' },
    }),
  }),
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
  apiKeys: [{ key: 'sk-ci', label: 'ci' }, { key: '{{env.PROXY_KEY}}' }],
  hasPassword: true,
  host: '127.0.0.1',
  logging: { enabled: true, level: 'info', retentionDays: 3 },
  port: 9317,
  proxy: '****',
  requireApiKey: true,
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
  const queryClient = new QueryClient();
  return render(<SettingsPage />, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
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

test('serves configured keys as editable plaintext and saves the whole array', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  // Same loopback and password gate as the provider credentials, which have always rendered
  // in the clear: a mask here bought nothing and cost the operator their only copy.
  const stored = within(group).getByDisplayValue('sk-ci');
  expect(stored).toHaveAttribute('type', 'text');
  expect(stored).not.toHaveAttribute('readonly');
  expect(within(group).getByDisplayValue('{{env.PROXY_KEY}}')).toBeInTheDocument();

  fireEvent.change(within(group).getAllByLabelText(/Label|标签|標籤|ラベル|라벨/u)[0] as HTMLElement, {
    target: { value: 'ci-renamed' },
  });
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ key: 'sk-ci', label: 'ci-renamed' }, { key: '{{env.PROXY_KEY}}' }],
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
    apiKeys: [{ key: 'sk-ci', label: 'ci' }, { key: '{{env.PROXY_KEY}}' }, { key: 'sk-added' }],
  });
});

test('adds, generates and saves a key when randomUUID is unavailable on HTTP', () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    renderPage();

    const group = screen.getByTestId('settings-group-api-keys');
    fireEvent.click(within(group).getByRole('button', { name: /Add key|添加密钥|新增金鑰|キーを追加|키 추가/u }));
    const dice = within(group).getAllByRole('button', {
      name: /Generate a key|随机生成密钥|隨機產生金鑰|キーを生成|키 생성/u,
    });
    fireEvent.click(dice[dice.length - 1] as HTMLElement);

    const values = within(group).getAllByLabelText(/^Key$|^密钥$|^金鑰$|^キー$|^키$/u);
    const generated = (values[values.length - 1] as HTMLInputElement).value;
    // A key too short or without enough entropy is worse than no key: it is a guessable credential.
    expect(generated).toMatch(/^sk-[0-9a-f]{48}$/u);

    fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      apiKeys: [{ key: 'sk-ci', label: 'ci' }, { key: '{{env.PROXY_KEY}}' }, { key: generated }],
    });
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
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
  expect(mocks.mutate).toHaveBeenCalledWith({ apiKeys: [{ key: '{{env.PROXY_KEY}}' }] });
});

test('reseeds stored API key rows when a reload replaces the stored keys', () => {
  const { rerender } = renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.change(within(group).getAllByLabelText(/Label|标签|標籤|ラベル|라벨/u)[0] as HTMLElement, {
    target: { value: 'stale-draft' },
  });

  mocks.useSettingsQuery.mockReturnValue({
    data: { ...settings, apiKeys: [{ key: 'sk-reloaded', label: 'reloaded' }] },
    isError: false,
    isLoading: false,
  });
  rerender(<SettingsPage />);

  const reloaded = screen.getByTestId('settings-group-api-keys');
  expect(within(reloaded).getByDisplayValue('sk-reloaded')).toBeInTheDocument();
  expect(within(reloaded).queryByDisplayValue('stale-draft')).toBeNull();

  fireEvent.click(within(reloaded).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));
  expect(mocks.mutate).toHaveBeenCalledWith({ apiKeys: [{ key: 'sk-reloaded', label: 'reloaded' }] });
});

test('refuses to save a labeled row whose key was left blank instead of dropping it', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(within(group).getByRole('button', { name: /Add key|添加密钥|新增金鑰|キーを追加|키 추가/u }));
  const labels = within(group).getAllByLabelText(/Label|标签|標籤|ラベル|라벨/u);
  fireEvent.change(labels[labels.length - 1] as HTMLElement, { target: { value: 'forgot-the-key' } });

  // Silently dropping the row would report success for a key that was never persisted.
  expect(
    within(group).getByText(/A key is required|必须填写密钥|必須填寫金鑰|キーは必須|키는 필수/u),
  ).toBeInTheDocument();
  const save = within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u });
  expect(save).toBeDisabled();
  fireEvent.click(save);
  expect(mocks.mutate).not.toHaveBeenCalled();
});

test('submits a key exactly as typed rather than trimming the credential', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(within(group).getByRole('button', { name: /Add key|添加密钥|新增金鑰|キーを追加|키 추가/u }));
  const values = within(group).getAllByLabelText(/^Key$|^密钥$|^金鑰$|^キー$|^키$/u);
  fireEvent.change(values[values.length - 1] as HTMLElement, { target: { value: ' sk-padded ' } });

  // The proxy compares the authored key byte for byte, so trimming here would store a
  // different credential than the one the operator handed out.
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ key: 'sk-ci', label: 'ci' }, { key: '{{env.PROXY_KEY}}' }, { key: ' sk-padded ' }],
  });
});

test('submits a whitespace-only key instead of silently dropping the row', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(within(group).getByRole('button', { name: /Add key|添加密钥|新增金鑰|キーを追加|키 추가/u }));
  const values = within(group).getAllByLabelText(/^Key$|^密钥$|^金鑰$|^キー$|^키$/u);
  fireEvent.change(values[values.length - 1] as HTMLElement, { target: { value: '   ' } });

  // The schema accepts any nonempty string, so whitespace is a usable credential. Treating it as
  // an empty row would report a successful save for a key that was never persisted.
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ key: 'sk-ci', label: 'ci' }, { key: '{{env.PROXY_KEY}}' }, { key: '   ' }],
  });
});

test('keeps an in-progress key draft when an unrelated save refreshes the settings object', () => {
  const { rerender } = renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.change(within(group).getAllByLabelText(/Label|标签|標籤|ラベル|라벨/u)[0] as HTMLElement, {
    target: { value: 'in-progress' },
  });

  // A password write re-fetches settings. The authored keys are untouched, so structural sharing
  // hands back the same array and the draft must survive.
  mocks.useSettingsQuery.mockReturnValue({
    data: { ...settings, hasPassword: false },
    isError: false,
    isLoading: false,
  });
  rerender(<SettingsPage />);

  const refreshed = screen.getByTestId('settings-group-api-keys');
  expect(within(refreshed).getByDisplayValue('in-progress')).toBeInTheDocument();
});

test('drops a saved new key row instead of leaving it beside its stored copy', () => {
  const { rerender } = renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(within(group).getByRole('button', { name: /Add key|添加密钥|新增金鑰|キーを追加|키 추가/u }));
  const values = within(group).getAllByLabelText(/^Key$|^密钥$|^金鑰$|^キー$|^키$/u);
  fireEvent.change(values[values.length - 1] as HTMLElement, { target: { value: 'sk-accepted' } });
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));

  // The accepted key comes back as a stored row; reseeding from the server is what retires the
  // draft, so the operator is not left staring at the same key twice.
  mocks.useSettingsQuery.mockReturnValue({
    data: { ...settings, apiKeys: [...settings.apiKeys, { key: 'sk-accepted' }] },
    isError: false,
    isLoading: false,
  });
  rerender(<SettingsPage />);

  const refreshed = screen.getByTestId('settings-group-api-keys');
  expect(within(refreshed).getAllByDisplayValue('sk-accepted')).toHaveLength(1);
  expect(within(refreshed).getAllByLabelText(/^Key$|^密钥$|^金鑰$|^キー$|^키$/u)).toHaveLength(3);
});

test('switches caller key enforcement off without touching the configured keys', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(
    within(group).getByRole('switch', {
      name: /Require a key|启用密钥校验|啟用金鑰驗證|キー認証を有効化|키 인증 사용/u,
    }),
  );

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ requireApiKey: false });
});

test('warns that configured keys are not enforced while the switch is off', () => {
  prepareMocks();
  mocks.useSettingsQuery.mockReturnValue({
    data: { ...settings, requireApiKey: false },
    isError: false,
    isLoading: false,
  });
  const queryClient = new QueryClient();
  render(<SettingsPage />, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });

  // Keys still listed but nothing checked is the one state an operator can misread as secure.
  const group = screen.getByTestId('settings-group-api-keys');
  expect(
    within(group).getByText(/Enforcement is off|校验已关闭|驗證已關閉|認証は無効|인증이 꺼져/u),
  ).toBeInTheDocument();
});
