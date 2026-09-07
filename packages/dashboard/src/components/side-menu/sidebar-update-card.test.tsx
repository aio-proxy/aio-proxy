import type { DashboardReleaseView } from '@aio-proxy/types';
import { SidebarProvider } from '@aio-proxy/ui/components/sidebar';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { SidebarUpdateCard } from './sidebar-update-card';

const mocks = rs.hoisted(() => ({
  apply: rs.fn(),
  release: rs.fn(),
  releaseQueryFn: rs.fn(),
  reloadDashboard: rs.fn(),
}));

rs.mock('@/modules/settings/hooks/use-release-query', () => ({
  useReleaseQuery: () => mocks.release(),
}));

rs.mock('@/modules/settings/services/release-service', () => ({
  applyReleaseMutationFn: mocks.apply,
  releaseQueryOptions: () => ({
    queryKey: ['release'],
    queryFn: mocks.releaseQueryFn,
  }),
}));

rs.mock('@/lib/reload-dashboard', () => ({ reloadDashboard: mocks.reloadDashboard }));

const updateNowName = /Update now|立即更新|今すぐ更新|지금 업데이트/u;
const updatingName = /Updating…|正在更新…|更新中…|업데이트 중…/u;
const availableName = /Update available|有可用更新|更新があります|업데이트 있음/u;
const restartRequired =
  /Restart aio-proxy to run the installed version|重启 aio-proxy 以运行已安装的版本|重新啟動 aio-proxy 以執行已安裝的版本|インストールしたバージョンを使うには aio-proxy を再起動してください|설치한 버전을 사용하려면 aio-proxy를 다시 시작하세요/u;
const updateFailed =
  /The update could not be installed|无法安装更新|無法安裝更新|更新をインストールできませんでした|업데이트를 설치할 수 없습니다/u;
const updateUnavailable =
  /This process cannot install updates|当前进程无法安装更新|目前處理程序無法安裝更新|このプロセスでは更新をインストールできません|이 프로세스에서는 업데이트를 설치할 수 없습니다/u;

const view = (extra: Partial<DashboardReleaseView> = {}): DashboardReleaseView => ({
  current: '1.4.2',
  latest: '1.10.0',
  outdated: true,
  managedService: false,
  update: { status: 'idle' },
  ...extra,
});

const renderCard = async (open = true) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SidebarProvider, { defaultOpen: open }, children),
    );
  return render(createElement(SidebarUpdateCard), { wrapper });
};

const prepare = (release = view()) => {
  mocks.apply.mockReset();
  mocks.release.mockReset();
  mocks.releaseQueryFn.mockReset();
  mocks.reloadDashboard.mockReset();
  mocks.release.mockReturnValue({ data: release });
  mocks.apply.mockResolvedValue({ ok: true, status: 'started' });
  mocks.releaseQueryFn.mockResolvedValue(release);
};

test('shows the available update and posts apply', async () => {
  prepare();
  await renderCard();

  expect(screen.getByText(availableName)).toBeInTheDocument();
  expect(screen.getByText('1.10.0')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: updateNowName }));
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
});

test('hides the card when the build is current', async () => {
  prepare(view({ latest: '1.4.2', outdated: false }));
  await renderCard();

  expect(screen.queryByText(availableName)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: updateNowName })).not.toBeInTheDocument();
});

test('renders a collapsed upgrade control instead of the card', async () => {
  prepare();
  await renderCard(false);

  expect(screen.queryByText('1.10.0')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: availableName })).toBeInTheDocument();
});

test('collapsed Update available expands the sidebar instead of applying', async () => {
  prepare();
  await renderCard(false);

  fireEvent.click(screen.getByRole('button', { name: availableName }));

  expect(mocks.apply).not.toHaveBeenCalled();
  expect(screen.getByText('1.10.0')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: updateNowName }));
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
});

test('disables Update now while an install is in progress', async () => {
  prepare(view({ update: { status: 'in_progress' } }));
  await renderCard();

  expect(screen.getByRole('button', { name: updatingName })).toBeDisabled();
});

test('shows restart required without Update now and does not reload', async () => {
  prepare(view({ update: { status: 'restart_required' } }));
  await renderCard();

  expect(screen.getByText(restartRequired)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: updateNowName })).not.toBeInTheDocument();
  expect(mocks.reloadDashboard).not.toHaveBeenCalled();
});

test('shows unavailable when apply cannot install updates', async () => {
  prepare();
  mocks.apply.mockRejectedValue(new Error('unavailable'));
  await renderCard();

  fireEvent.click(screen.getByRole('button', { name: updateNowName }));

  await waitFor(() => expect(screen.getByText(updateUnavailable)).toBeInTheDocument());
  expect(screen.getByRole('button', { name: updateNowName })).toBeEnabled();
});

test('keeps the card and Update now after a failed install', async () => {
  prepare(view({ update: { status: 'failed' } }));
  await renderCard();

  expect(screen.getByText(updateFailed)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: updateNowName })).toBeEnabled();
});
