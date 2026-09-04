import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { SettingsAboutGroup } from './settings-about-group';

const mocks = rs.hoisted(() => ({ check: rs.fn(), release: rs.fn() }));

rs.mock('../../hooks/use-release-query', () => ({
  useReleaseQuery: () => mocks.release(),
}));

rs.mock('../../services/release-service', () => ({
  checkLatestReleaseMutationFn: mocks.check,
}));

const renderGroup = async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return render(createElement(SettingsAboutGroup), { wrapper });
};

const clickCheck = () =>
  fireEvent.click(
    screen.getByRole('button', { name: /Check for updates|检查新版本|檢查新版本|更新を確認|업데이트 확인/u }),
  );

test('links the running version to its release tag and points at the repo and docs', async () => {
  mocks.release.mockReturnValue({ data: { current: '1.4.2' } });
  await renderGroup();

  const group = screen.getByTestId('settings-group-about');
  const links = within(group).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    'https://github.com/aio-proxy/aio-proxy/releases/tag/v1.4.2',
    'https://github.com/aio-proxy/aio-proxy',
    'https://aio-proxy.github.io',
  ]);
  // An external tab must not be able to reach back into an authenticated Dashboard.
  for (const link of links) expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
});

test('announces a newer published version after the check', async () => {
  mocks.release.mockReturnValue({ data: { current: '1.4.2' } });
  mocks.check.mockResolvedValue({ current: '1.4.2', latest: '1.10.0', outdated: true });
  await renderGroup();

  clickCheck();

  await waitFor(() => expect(screen.getByText(/1\.10\.0/u)).toBeInTheDocument());
});

test('does not claim the build is current when the registry is unreachable', async () => {
  mocks.release.mockReturnValue({ data: { current: '1.4.2' } });
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
  expect(
    screen.queryByText(
      /latest published version|已是最新发布版本|已是最新發布版本|最新の公開バージョン|최신 배포 버전/u,
    ),
  ).toBeNull();
});
