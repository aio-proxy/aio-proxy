import type { AgentLocalState, AgentsSnapshot } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { render, screen, within } from '@testing-library/react';

import { AgentsPage } from './agents-page';

const mocks = rs.hoisted(() => ({
  snapshot: { data: undefined as AgentsSnapshot | undefined, isError: false, isLoading: false },
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: object }) => (
    <a href={to.replace('$target', String((params as { target?: string } | undefined)?.target ?? ''))} {...props} />
  ),
}));
rs.mock('@/components/page-container', () => ({
  PageContainer: ({ children, title }: React.PropsWithChildren<{ title?: React.ReactNode }>) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));
rs.mock('../../hooks/use-agents-snapshot', () => ({ useAgentsSnapshot: () => mocks.snapshot }));

const local = (target: AgentLocalState['target'], status: AgentLocalState['status']): AgentLocalState => ({
  target,
  host: { detected: status !== 'not_installed', support: 'supported' },
  status,
});

const snapshot = (overrides: Partial<AgentsSnapshot> = {}): AgentsSnapshot => ({
  localSetup: 'available',
  deviceAuthorization: 'available',
  adapterVersion: '1.0.0',
  installations: [],
  local: [local('opencode', 'configured'), local('pi', 'not_installed'), local('codex', 'modified')],
  ...overrides,
});

test('lists every supported Agent with its local status when setup is available here', () => {
  mocks.snapshot.data = snapshot();
  render(<AgentsPage />);
  for (const target of ['opencode', 'pi', 'omp', 'codex', 'grok'])
    expect(screen.getByTestId(`agent-card-${target}`)).toBeTruthy();
  expect(within(screen.getByTestId('agent-card-pi')).getByText(/Not installed|未安装/u)).toBeTruthy();
  expect(
    within(screen.getByTestId('agent-card-opencode'))
      .getByRole('button', { name: /OpenCode/u })
      .getAttribute('href'),
  ).toBe('/agents/opencode');
  expect(screen.queryByTestId('agents-banner')).toBeNull();
});

test.each([
  ['remote_request', /another machine|其他机器/u],
  ['unavailable', /container|容器/u],
] as const)('explains why one-click setup is off for %s', (localSetup, message) => {
  const { local: _local, ...rest } = snapshot();
  mocks.snapshot.data = { ...rest, localSetup };
  render(<AgentsPage />);
  expect(screen.getByTestId('agents-banner').textContent).toMatch(message);
});

test('warns when Agent authorization needs a Dashboard password', () => {
  mocks.snapshot.data = snapshot({ deviceAuthorization: 'password_required' });
  render(<AgentsPage />);
  expect(screen.getByRole('alert').textContent).toMatch(/password|密码/iu);
});
