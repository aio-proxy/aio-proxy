import type { DashboardSettingsView } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { SettingsPage } from '.';

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

const settings: DashboardSettingsView = {
  hasPassword: true,
  host: '127.0.0.1',
  logging: { enabled: true, level: 'info', retentionDays: 14 },
  port: 9317,
  proxy: '****',
  retryAfterCapMs: 30_000,
};

const renderPage = (restartRequired?: boolean) => {
  mocks.mutate.mockReset();
  mocks.useSettingsQuery.mockReturnValue({ data: settings, isError: false, isLoading: false });
  mocks.useSettingsMutation.mockReturnValue({
    data: restartRequired === undefined ? undefined : { ok: true, restartRequired, settings },
    isError: false,
    isPending: false,
    mutate: mocks.mutate,
  });
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

test('shows only masked read-only password state without password mutation actions', () => {
  renderPage();

  const password = screen.getByLabelText(/Dashboard password|控制台密码|控制台密碼/u);
  expect(password).toHaveAttribute('type', 'password');
  expect(password).toHaveAttribute('readonly');
  expect(password).toHaveValue('********');
  expect(screen.queryByRole('button', { name: /clear|refill|replace|reset|清除|替换|取代/u })).not.toBeInTheDocument();
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

test('shows restart guidance only when the server reports restartRequired', () => {
  const restart = renderPage(true);
  expect(screen.getByRole('status')).toHaveTextContent(/Restart aio-proxy|重启 aio-proxy|重新啟動 aio-proxy/u);

  restart.unmount();
  renderPage(false);
  expect(screen.getByRole('status')).toHaveTextContent(/Settings saved|设置已保存|設定已儲存/u);
  expect(screen.getByRole('status')).not.toHaveTextContent(/Restart aio-proxy|重启 aio-proxy|重新啟動 aio-proxy/u);
});
