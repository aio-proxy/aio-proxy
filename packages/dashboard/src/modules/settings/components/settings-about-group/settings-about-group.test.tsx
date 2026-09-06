import type { DashboardReleaseView } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { SettingsAboutGroup } from './settings-about-group';

const mocks = rs.hoisted(() => ({
  apply: rs.fn(),
  check: rs.fn(),
  release: rs.fn(),
  releaseQueryFn: rs.fn(),
  reloadDashboard: rs.fn(),
  settingsMutate: rs.fn(),
  settingsQuery: rs.fn(),
}));

rs.mock('../../hooks/use-release-query', () => ({
  useReleaseQuery: () => mocks.release(),
}));

rs.mock('../../hooks/use-settings-query', () => ({
  useSettingsQuery: () => mocks.settingsQuery(),
}));

rs.mock('../../hooks/use-settings-mutation', () => ({
  useSettingsMutation: () => ({ isPending: false, mutate: mocks.settingsMutate }),
}));

rs.mock('../../services/release-service', () => ({
  applyReleaseMutationFn: mocks.apply,
  checkLatestReleaseMutationFn: mocks.check,
  releaseQueryOptions: () => ({
    queryKey: ['release'],
    queryFn: mocks.releaseQueryFn,
  }),
}));

rs.mock('@/lib/reload-dashboard', () => ({ reloadDashboard: mocks.reloadDashboard }));

const idleRelease: DashboardReleaseView = {
  current: '1.4.2',
  managedService: false,
  update: { status: 'idle' },
};

const autoUpdateName = /Automatic updates|自动更新|自動更新|자동 업데이트/u;
const unmanagedHint =
  /Automatic install runs only under a managed service|自动安装仅在托管服务下生效|自動安裝僅在受管服務下生效|自動インストールはマネージドサービスでのみ実行されます|자동 설치는 관리 서비스에서만 실행됩니다/u;
const updateNowName = /Update now|立即更新|今すぐ更新|지금 업데이트/u;
const updatingName = /Updating…|正在更新…|更新中…|업데이트 중…/u;
const updateFailed =
  /The update could not be installed|无法安装更新|無法安裝更新|更新をインストールできませんでした|업데이트를 설치할 수 없습니다/u;
const restartRequired =
  /Restart aio-proxy to run the installed version|重启 aio-proxy 以运行已安装的版本|重新啟動 aio-proxy 以執行已安裝的版本|インストールしたバージョンを使うには aio-proxy を再起動してください|설치한 버전을 사용하려면 aio-proxy를 다시 시작하세요/u;
const upToDate = /latest published version|已是最新发布版本|已是最新發布版本|最新の公開バージョン|최신 배포 버전/u;

const renderGroup = async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return render(createElement(SettingsAboutGroup), { wrapper });
};

const clickCheck = () =>
  fireEvent.click(
    screen.getByRole('button', { name: /Check for updates|检查新版本|檢查新版本|更新を確認|업데이트 확인/u }),
  );

const prepare = (release = idleRelease) => {
  mocks.apply.mockReset();
  mocks.check.mockReset();
  mocks.release.mockReset();
  mocks.releaseQueryFn.mockReset();
  mocks.reloadDashboard.mockReset();
  mocks.settingsMutate.mockReset();
  mocks.settingsQuery.mockReset();
  mocks.release.mockReturnValue({ data: release });
  mocks.settingsQuery.mockReturnValue({ data: { autoUpdate: false }, isError: false, isLoading: false });
  mocks.apply.mockResolvedValue({ ok: true, status: 'started' });
  mocks.releaseQueryFn.mockResolvedValue(release);
};

test('shows the running version and links it to its release tag, the repo, and the docs', async () => {
  prepare();
  await renderGroup();

  const group = screen.getByTestId('settings-group-about');
  expect(within(group).getByText(/1\.4\.2/u)).toBeInTheDocument();

  const links = within(group).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    'https://github.com/aio-proxy/aio-proxy/releases/tag/v1.4.2',
    'https://github.com/aio-proxy/aio-proxy',
    'https://aioproxy.dev',
  ]);
  // Icon-only links still need a name, or they read as "link" and nothing else.
  for (const link of links) {
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(link).toHaveAccessibleName();
  }
});

test('announces a newer published version after the check', async () => {
  prepare();
  mocks.check.mockResolvedValue({ current: '1.4.2', latest: '1.10.0', outdated: true });
  await renderGroup();

  clickCheck();

  await waitFor(() => expect(screen.getByText(/1\.10\.0/u)).toBeInTheDocument());
});

test('does not claim the build is current when the registry is unreachable', async () => {
  prepare();
  mocks.check.mockRejectedValue(new Error('check_failed'));
  await renderGroup();

  clickCheck();

  await waitFor(() =>
    expect(
      screen.getByText(
        /Could not reach the registry|无法连接软件源|無法連線至套件來源|レジストリに接続|레지스트리에 연결/u,
      ),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByText(upToDate)).toBeNull();
});

test('saves Automatic updates through the settings mutation', async () => {
  prepare();
  await renderGroup();

  fireEvent.click(screen.getByRole('switch', { name: autoUpdateName }));

  expect(mocks.settingsMutate.mock.calls[0]?.[0]).toEqual({ autoUpdate: true });
});

test('shows the unmanaged hint only when the process is not a managed service', async () => {
  prepare({ ...idleRelease, managedService: false });
  const unmanaged = await renderGroup();
  expect(screen.getByText(unmanagedHint)).toBeInTheDocument();
  unmanaged.unmount();

  prepare({ ...idleRelease, managedService: true });
  await renderGroup();
  expect(screen.queryByText(unmanagedHint)).toBeNull();
});

test('apply up_to_date clears a stale outdated Check so Update now is not stuck enabled', async () => {
  prepare();
  mocks.check.mockResolvedValue({ current: '1.4.2', latest: '1.10.0', outdated: true });
  mocks.apply.mockResolvedValue({ ok: true, status: 'up_to_date' });
  await renderGroup();

  clickCheck();
  const update = screen.getByRole('button', { name: updateNowName });
  await waitFor(() => expect(update).toBeEnabled());

  fireEvent.click(update);
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(update).toBeDisabled());
});

test('enables Update now after an outdated check and posts apply', async () => {
  prepare();
  mocks.check.mockResolvedValue({ current: '1.4.2', latest: '1.10.0', outdated: true });
  await renderGroup();

  const update = screen.getByRole('button', { name: updateNowName });
  expect(update).toBeDisabled();

  clickCheck();
  await waitFor(() => expect(update).toBeEnabled());

  fireEvent.click(update);
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
});

test('disables Update now and polls when GET already reports in_progress', async () => {
  prepare({ current: '1.4.2', managedService: false, update: { status: 'in_progress' } });
  await renderGroup();

  expect(screen.getByRole('button', { name: updatingName })).toBeDisabled();
  await waitFor(() => expect(mocks.releaseQueryFn).toHaveBeenCalled());
});

test('starts the same poll when apply reports in_progress', async () => {
  prepare();
  mocks.check.mockResolvedValue({ current: '1.4.2', latest: '1.10.0', outdated: true });
  mocks.apply.mockRejectedValue(new Error('in_progress'));
  await renderGroup();

  clickCheck();
  const update = await screen.findByRole('button', { name: updateNowName });
  await waitFor(() => expect(update).toBeEnabled());
  fireEvent.click(update);

  await waitFor(() => expect(screen.getByRole('button', { name: updatingName })).toBeDisabled());
  await waitFor(() => expect(mocks.releaseQueryFn).toHaveBeenCalled());
});

test('shows a failed update without claiming the build is current', async () => {
  prepare({ current: '1.4.2', managedService: false, update: { status: 'failed' } });
  mocks.check.mockResolvedValue({ current: '1.4.2', latest: '1.4.2', outdated: false });
  await renderGroup();

  clickCheck();

  await waitFor(() => expect(screen.getByText(updateFailed)).toBeInTheDocument());
  expect(screen.queryByText(upToDate)).toBeNull();
});

test('shows restart required, disables Update now, and does not reload', async () => {
  prepare({ current: '1.4.2', managedService: false, update: { status: 'restart_required' } });
  mocks.check.mockResolvedValue({ current: '1.4.2', latest: '1.10.0', outdated: true });
  await renderGroup();

  clickCheck();
  await waitFor(() => expect(screen.getByText(/1\.10\.0/u)).toBeInTheDocument());

  expect(screen.getByText(restartRequired)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: updateNowName })).toBeDisabled();
  expect(mocks.reloadDashboard).not.toHaveBeenCalled();
  expect(mocks.releaseQueryFn).not.toHaveBeenCalled();
});

test('hides Automatic updates while settings are loading and keeps version check', async () => {
  prepare();
  mocks.settingsQuery.mockReturnValue({ data: undefined, isError: false, isLoading: true });
  await renderGroup();

  expect(screen.queryByRole('switch', { name: autoUpdateName })).toBeNull();
  expect(
    screen.getByRole('button', { name: /Check for updates|检查新版本|檢查新版本|更新を確認|업데이트 확인/u }),
  ).toBeInTheDocument();
});
