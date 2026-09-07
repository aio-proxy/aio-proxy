import type { DashboardReleaseView } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { SettingsUpdateNowButton } from './settings-update-now-button';

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

const idleRelease: DashboardReleaseView = {
  current: '1.4.2',
  outdated: false,
  managedService: false,
  update: { status: 'idle' },
};

const withRelease = (
  update: DashboardReleaseView['update']['status'],
  extra: Partial<DashboardReleaseView> = {},
): DashboardReleaseView => ({
  current: '1.4.2',
  outdated: false,
  managedService: false,
  update: { status: update },
  ...extra,
});

const updateNowName = /Update now|立即更新|今すぐ更新|지금 업데이트/u;
const updatingName = /Updating…|正在更新…|更新中…|업데이트 중…/u;
const updateFailed =
  /The update could not be installed|无法安装更新|無法安裝更新|更新をインストールできませんでした|업데이트를 설치할 수 없습니다/u;
const updateUnavailable =
  /This process cannot install updates|当前进程无法安装更新|目前處理程序無法安裝更新|このプロセスでは更新をインストールできません|이 프로세스에서는 업데이트를 설치할 수 없습니다/u;
const restartRequired =
  /Restart aio-proxy to run the installed version|重启 aio-proxy 以运行已安装的版本|重新啟動 aio-proxy 以執行已安裝的版本|インストールしたバージョンを使うには aio-proxy を再起動してください|설치한 버전을 사용하려면 aio-proxy를 다시 시작하세요/u;

afterEach(() => {
  rs.useRealTimers();
});

const renderButton = async (outdated: boolean, seed?: DashboardReleaseView, onUpToDate?: () => void) => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  if (seed !== undefined) queryClient.setQueryData(['release'], seed);
  const invalidateQueries = rs.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return {
    invalidateQueries,
    ...render(createElement(SettingsUpdateNowButton, { outdated, onUpToDate }), { wrapper }),
  };
};

const prepare = (release = idleRelease) => {
  mocks.apply.mockReset();
  mocks.release.mockReset();
  mocks.releaseQueryFn.mockReset();
  mocks.reloadDashboard.mockReset();
  mocks.release.mockReturnValue({ data: release });
  mocks.apply.mockResolvedValue({ ok: true, status: 'started' });
  mocks.releaseQueryFn.mockResolvedValue(release);
};

test('posts apply when Update now is clicked while outdated', async () => {
  prepare();
  await renderButton(true);

  fireEvent.click(screen.getByRole('button', { name: updateNowName }));
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
});

test('disables Update now and polls when GET already reports in_progress', async () => {
  prepare(withRelease('in_progress'));
  await renderButton(true);

  expect(screen.getByRole('button', { name: updatingName })).toBeDisabled();
  await waitFor(() => expect(mocks.releaseQueryFn).toHaveBeenCalled());
});

test('starts the same poll when apply reports in_progress', async () => {
  prepare();
  mocks.apply.mockRejectedValue(new Error('in_progress'));
  await renderButton(true);

  fireEvent.click(screen.getByRole('button', { name: updateNowName }));

  await waitFor(() => expect(screen.getByRole('button', { name: updatingName })).toBeDisabled());
  await waitFor(() => expect(mocks.releaseQueryFn).toHaveBeenCalled());
});

test('reloads the Dashboard when poll sees current change', async () => {
  prepare(withRelease('in_progress'));
  mocks.releaseQueryFn.mockResolvedValue(withRelease('idle', { current: '1.5.0' }));
  await renderButton(true);

  await waitFor(() => expect(mocks.reloadDashboard).toHaveBeenCalledTimes(1));
});

test('shows a failed update from GET without reloading', async () => {
  prepare(withRelease('failed'));
  await renderButton(true);

  expect(screen.getByText(updateFailed)).toBeInTheDocument();
  expect(mocks.reloadDashboard).not.toHaveBeenCalled();
  expect(mocks.releaseQueryFn).not.toHaveBeenCalled();
});

test('shows unavailable when apply cannot install updates', async () => {
  prepare();
  mocks.apply.mockRejectedValue(new Error('unavailable'));
  await renderButton(true);

  fireEvent.click(screen.getByRole('button', { name: updateNowName }));

  await waitFor(() => expect(screen.getByText(updateUnavailable)).toBeInTheDocument());
  expect(mocks.releaseQueryFn).not.toHaveBeenCalled();
});

test('shows restart required, stops polling, and does not reload', async () => {
  prepare(withRelease('in_progress'));
  mocks.releaseQueryFn.mockResolvedValue(withRelease('restart_required'));
  await renderButton(true);

  await waitFor(() => expect(screen.getByText(restartRequired)).toBeInTheDocument());
  expect(screen.getByRole('button', { name: updateNowName })).toBeDisabled();
  const calls = mocks.releaseQueryFn.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mocks.releaseQueryFn.mock.calls.length).toBe(calls);
  expect(mocks.reloadDashboard).not.toHaveBeenCalled();
});

test('stops polling and returns to idle after apply started then GET idle', async () => {
  prepare();
  let finishPoll: (view: DashboardReleaseView) => void = () => {
    /* assigned when the poll query runs */
  };
  mocks.releaseQueryFn.mockImplementation(
    () =>
      new Promise<DashboardReleaseView>((resolve) => {
        finishPoll = resolve;
      }),
  );
  await renderButton(true, idleRelease);

  fireEvent.click(screen.getByRole('button', { name: updateNowName }));

  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('button', { name: updatingName })).toBeDisabled());

  finishPoll(idleRelease);

  await waitFor(() => expect(screen.getByRole('button', { name: updateNowName })).toBeEnabled());
  expect(screen.queryByRole('button', { name: updatingName })).not.toBeInTheDocument();
  expect(screen.queryByText(updateFailed)).not.toBeInTheDocument();
  expect(screen.queryByText(restartRequired)).not.toBeInTheDocument();

  const calls = mocks.releaseQueryFn.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mocks.releaseQueryFn.mock.calls.length).toBe(calls);
});

test('shows failed and re-enables Update now after 120s when GET is still in_progress', async () => {
  rs.useFakeTimers();
  prepare();
  mocks.releaseQueryFn.mockResolvedValue(withRelease('in_progress'));
  await renderButton(true);

  fireEvent.click(screen.getByRole('button', { name: updateNowName }));
  await rs.advanceTimersByTimeAsync(0);
  expect(screen.getByRole('button', { name: updatingName })).toBeDisabled();

  await rs.advanceTimersByTimeAsync(120_000);

  expect(screen.getByText(updateFailed)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: updateNowName })).toBeEnabled();
  const calls = mocks.releaseQueryFn.mock.calls.length;
  await rs.advanceTimersByTimeAsync(4_000);
  expect(mocks.releaseQueryFn.mock.calls.length).toBe(calls);
});

test('starts the poll when apply fails with a transport error', async () => {
  prepare();
  mocks.apply.mockRejectedValue(new Error('Failed to fetch'));
  await renderButton(true);

  fireEvent.click(screen.getByRole('button', { name: updateNowName }));

  await waitFor(() => expect(screen.getByRole('button', { name: updatingName })).toBeDisabled());
  await waitFor(() => expect(mocks.releaseQueryFn).toHaveBeenCalled());
  expect(screen.queryByText(updateFailed)).not.toBeInTheDocument();
});

test('apply up_to_date dismisses Update now and notifies the parent', async () => {
  prepare();
  mocks.apply.mockResolvedValue({ ok: true, status: 'up_to_date' });
  const onUpToDate = rs.fn();
  const { invalidateQueries } = await renderButton(true, undefined, onUpToDate);

  fireEvent.click(screen.getByRole('button', { name: updateNowName }));

  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(onUpToDate).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: updateNowName })).toBeDisabled();
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['release'] });
});

test('retries polling after a previous failed apply', async () => {
  prepare(withRelease('failed'));
  mocks.releaseQueryFn.mockResolvedValue(withRelease('in_progress'));
  await renderButton(true);

  expect(screen.getByText(updateFailed)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: updateNowName }));

  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('button', { name: updatingName })).toBeDisabled());
  await waitFor(() => expect(mocks.releaseQueryFn).toHaveBeenCalled());
});
