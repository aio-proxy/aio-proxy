import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderSyncControl } from './provider-sync-control';

test('excluding a Provider calls range change and never purges cloud data', () => {
  const onExclude = rs.fn().mockResolvedValue(undefined);
  render(
    <ProviderSyncControl
      state={{
        providerId: 'work',
        objectId: 'object-work',
        included: true,
        credentialState: 'shared',
        pendingReason: null,
      }}
      onEnable={rs.fn()}
      onExclude={onExclude}
      onDetach={rs.fn()}
    />,
  );

  fireEvent.click(screen.getByRole('switch', { name: /Sync this Provider|同步此 Provider/u }));
  expect(onExclude).toHaveBeenCalledTimes(1);
});

test('discloses pending credentials without adding a second consent control', () => {
  render(
    <ProviderSyncControl
      state={{
        providerId: 'work',
        objectId: 'object-work',
        included: true,
        credentialState: 'unverified',
        pendingReason: null,
      }}
      onEnable={rs.fn()}
      onExclude={rs.fn()}
      onDetach={rs.fn()}
    />,
  );

  expect(screen.getByText(/Credential copied|凭据已复制/u)).toBeTruthy();
  expect(screen.getAllByRole('switch')).toHaveLength(1);
});

test('shows login-required state when detaching without a session and keeps detach available while pending', async () => {
  const onDetach = rs.fn().mockRejectedValue({ code: 'login-required' });
  render(
    <ProviderSyncControl
      state={{
        providerId: 'work',
        objectId: 'object-work',
        included: false,
        credentialState: 'detach-pending',
        pendingReason: 'login required',
      }}
      onEnable={rs.fn()}
      onExclude={rs.fn()}
      onDetach={onDetach}
    />,
  );

  const button = screen.getByRole('button', { name: /Disconnect|연결 해제|接続を解除|断开连接|中斷連線/u });
  expect(button).toBeTruthy();
  fireEvent.click(button);

  expect(await screen.findByText(/Sign in again to manage shared credentials|请重新登录以管理共享凭据/u)).toBeTruthy();
  expect(onDetach).toHaveBeenCalledTimes(1);
});
