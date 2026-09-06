import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { SettingsAutoUpdateRow } from './settings-auto-update-row';

const mocks = rs.hoisted(() => ({ mutate: rs.fn() }));

rs.mock('../../hooks/use-settings-mutation', () => ({
  useSettingsMutation: () => ({ isPending: false, mutate: mocks.mutate }),
}));

const autoUpdateName = /Automatic updates|自动更新|自動更新|자동 업데이트/u;
const unmanagedHint =
  /Automatic install runs only under a managed service|自动安装仅在托管服务下生效|自動安裝僅在受管服務下生效|自動インストールはマネージドサービスでのみ実行されます|자동 설치는 관리 서비스에서만 실행됩니다/u;

const renderRow = async (managedService: boolean, autoUpdate = false) => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return render(createElement(SettingsAutoUpdateRow, { autoUpdate, managedService }), { wrapper });
};

test('saves Automatic updates through the settings mutation', async () => {
  mocks.mutate.mockReset();
  await renderRow(true);

  fireEvent.click(screen.getByRole('switch', { name: autoUpdateName }));

  expect(mocks.mutate).toHaveBeenCalledWith({ autoUpdate: true });
});

test('shows the unmanaged hint only when the process is not a managed service', async () => {
  const unmanaged = await renderRow(false);
  expect(screen.getByText(unmanagedHint)).toBeInTheDocument();
  unmanaged.unmount();

  await renderRow(true);
  expect(screen.queryByText(unmanagedHint)).toBeNull();
});
