import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { LoginPanel } from './login-panel';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const mocks = rs.hoisted(() => ({
  login: {
    pending: undefined as Extract<AgentAuthorizationDetails, { status: 'pending' }> | undefined,
    decide: rs.fn(),
    decision: undefined,
    isDeciding: false,
    failed: false,
  },
}));

rs.mock('../../hooks/use-agent-login', () => ({ useAgentLogin: () => mocks.login }));

test('approval controls disappear once the pending request expires or is decided elsewhere', () => {
  mocks.login.pending = {
    status: 'pending',
    deviceId: '3f1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c',
    target: 'opencode',
    installationId: INSTALLATION,
    adapterVersion: '1.0.0',
    expiresAt: '2026-09-26T00:10:00.000Z',
    permissions: ['catalog', 'inference'],
  };
  const view = render(
    <LoginPanel target="opencode" installationId={INSTALLATION} loginCommand="opencode auth login" />,
  );
  expect(screen.getByRole('button', { name: /Approve|批准/u })).toBeTruthy();

  mocks.login.pending = undefined;
  view.rerender(<LoginPanel target="opencode" installationId={INSTALLATION} loginCommand="opencode auth login" />);
  expect(screen.queryByRole('button', { name: /Approve|批准/u })).toBeNull();
});
