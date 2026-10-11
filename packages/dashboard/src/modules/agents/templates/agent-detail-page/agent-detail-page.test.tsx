import type {
  AgentLocalState,
  AgentOperationState,
  AgentsSnapshot,
  ClaudeCodeSetupPlan,
  CodexSetupPlan,
} from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AgentDetailPage } from './agent-detail-page';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';

const mocks = rs.hoisted(() => ({
  snapshot: { data: undefined as AgentsSnapshot | undefined, isError: false, isLoading: false },
  operation: {
    state: undefined as AgentOperationState | undefined,
    adopted: false,
    start: rs.fn(),
    startError: null,
    isStarting: false,
    decide: rs.fn(),
    isDeciding: false,
    busy: false,
    reset: rs.fn(),
  },
  plan: { data: undefined as CodexSetupPlan | undefined, isError: false, isLoading: false, error: null },
  claudeCodePlan: {
    data: undefined as ClaudeCodeSetupPlan | undefined,
    isError: false,
    isFetching: false,
    error: null,
    dataUpdatedAt: 0,
    refetch: rs.fn(),
  },
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props} />
  ),
}));
rs.mock('@/components/page-container', () => ({
  PageContainer: ({
    children,
    title,
    extra,
  }: React.PropsWithChildren<{ title?: React.ReactNode; extra?: React.ReactNode }>) => (
    <main>
      <h1>{title}</h1>
      {extra}
      {children}
    </main>
  ),
}));
rs.mock('../../hooks/use-agents-snapshot', () => ({ useAgentsSnapshot: () => mocks.snapshot }));
rs.mock('../../hooks/use-agent-operation', () => ({ useAgentOperation: () => mocks.operation }));
rs.mock('../../hooks/use-codex-plan', () => ({ useCodexPlan: () => mocks.plan }));
rs.mock('../../hooks/use-claude-code-plan', () => ({ useClaudeCodePlan: () => mocks.claudeCodePlan }));
rs.mock('../../hooks/use-agent-login', () => ({
  useAgentLogin: () => ({ pending: undefined, decide: rs.fn(), decision: undefined, isDeciding: false, failed: false }),
}));

rs.mock('../../hooks/use-revoke-installation', () => ({
  useRevokeInstallation: () => ({ mutate: rs.fn(), isPending: false }),
}));

afterEach(() => {
  mocks.operation.state = undefined;
  mocks.operation.start.mockReset();
  mocks.plan.data = undefined;
});

const local = (target: AgentLocalState['target'], status: AgentLocalState['status']): AgentLocalState => ({
  target,
  host: { detected: true, version: '2.0.0', support: 'supported' },
  status,
  ...(status === 'not_configured' ? {} : { installationId: INSTALLATION }),
});

const snapshot = (
  target: AgentLocalState['target'],
  status: AgentLocalState['status'],
  overrides: Partial<AgentsSnapshot> = {},
) => ({
  localSetup: 'available' as const,
  deviceAuthorization: 'available' as const,
  adapterVersion: '2.0.0',
  installations: [
    {
      installationId: INSTALLATION,
      target,
      adapterVersion: '2.0.0',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastAuthorizedAt: '2026-09-01T00:00:00.000Z',
      authorization: 'active' as const,
      accessExpiresAt: null,
    },
  ],
  local: [local(target, status)],
  ...overrides,
});

test('a plugin Agent offers one-click configure, notes, and its authorizations', () => {
  mocks.snapshot.data = snapshot('opencode', 'not_configured');
  render(<AgentDetailPage target="opencode" />);
  fireEvent.click(screen.getByRole('button', { name: /^(Configure|配置)$/u }));
  expect(mocks.operation.start).toHaveBeenCalledWith({ kind: 'configure', target: 'opencode' });
  expect(screen.getByTestId('agent-notes').textContent).toMatch(/synced|同步/u);
  expect(screen.getByTestId('agent-installations-table').textContent).toContain(INSTALLATION);
  expect(screen.getByRole('columnheader', { name: /^(Created|创建时间)/u })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /Filter authorizations|筛选授权/u })).toBeTruthy();
  // Manual setup lives on the docs site rather than as commands on this page.
  expect(screen.getByRole('button', { name: /Setup guide|接入文档/u }).getAttribute('href')).toMatch(
    /aioproxy\.dev\/(zh\/)?guide\/integrations\/agents\/opencode$/u,
  );
});

test('Grok shows its platform note, and edited managed fields leave only Remove', () => {
  mocks.snapshot.data = snapshot('grok', 'modified');
  render(<AgentDetailPage target="grok" />);
  expect(screen.getByTestId('agent-notes').textContent).toMatch(/macOS/u);
  // Configure refuses to overwrite the edits, so a Repair button could only fail.
  expect(screen.queryByRole('button', { name: /^(Repair|修复)$/u })).toBeNull();
  expect(screen.getByRole('button', { name: /^(Remove|移除)$/u })).toBeTruthy();
});

test('Codex opens the setup form instead of configuring immediately', () => {
  mocks.snapshot.data = snapshot('codex', 'not_configured');
  mocks.plan.data = {
    configPath: '/home/me/.codex/config.toml',
    inspection: { status: 'absent' },
    defaultProviderId: 'aio-proxy',
    defaultAuthMode: 'command',
    occupiedProviderIds: [],
    keyChoices: [],
    sessions: { groups: [], blocked: 0 },
    planToken: 'token',
  };
  render(<AgentDetailPage target="codex" />);
  fireEvent.click(screen.getByRole('button', { name: /^(Configure|配置)$/u }));
  expect(mocks.operation.start).not.toHaveBeenCalled();
  expect(screen.getByTestId('codex-setup-form')).toBeTruthy();
});

test('a remote browser sees state and the setup guide but cannot write', () => {
  const { local: _local, ...remote } = snapshot('opencode', 'configured');
  mocks.snapshot.data = { ...remote, localSetup: 'remote_request' };
  render(<AgentDetailPage target="opencode" />);
  expect(screen.queryByTestId('agent-status-panel')).toBeNull();
  expect((screen.getByRole('button', { name: /^(Revoke|撤销)$/u }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: /Setup guide|接入文档/u })).toBeTruthy();
});

test('an operation awaiting approval is shown inline on the detail page', () => {
  mocks.snapshot.data = snapshot('codex', 'configured');
  mocks.operation.state = {
    operationId: '3f1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c',
    target: 'codex',
    kind: 'configure',
    status: 'awaiting_approval',
    installationId: INSTALLATION,
    userCode: 'WXYZ-2345',
    expiresAt: '2026-09-26T00:10:00.000Z',
  };
  render(<AgentDetailPage target="codex" />);
  expect(screen.getAllByTestId('operation-approval').length).toBeGreaterThan(0);
});

test.each([
  ['expired', true],
  ['active', false],
] as const)('a configured plugin whose authorization is %s offers the login panel: %s', (authorization, shown) => {
  const data = snapshot('opencode', 'configured');
  mocks.snapshot.data = { ...data, installations: data.installations.map((item) => ({ ...item, authorization })) };
  render(<AgentDetailPage target="opencode" />);
  expect(screen.queryByTestId('login-panel') !== null).toBe(shown);
});

test('reconfiguring an Agent that is already signed in does not ask it to log in again', () => {
  mocks.snapshot.data = snapshot('opencode', 'configured');
  mocks.operation.state = {
    operationId: '3f1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c',
    target: 'opencode',
    kind: 'configure',
    status: 'succeeded',
    result: {
      target: 'opencode',
      status: 'updated',
      installationId: INSTALLATION,
      loginCommand: 'opencode auth login',
    },
  } as AgentOperationState;
  render(<AgentDetailPage target="opencode" />);
  expect(screen.queryByTestId('login-panel')).toBeNull();
});

test('Claude Code configures in one click without proxy keys and asks for a key when the proxy has them', async () => {
  const configure = { name: /^(Configure|配置)$/u };
  mocks.claudeCodePlan.refetch.mockImplementation(async () => ({ data: mocks.claudeCodePlan.data, isError: false }));
  mocks.snapshot.data = snapshot('claude-code', 'not_configured', { installations: [] });
  mocks.claudeCodePlan.data = { configPath: '/home/me/.claude/settings.json', keyChoices: [] };
  const first = render(<AgentDetailPage target="claude-code" />);
  fireEvent.click(screen.getByRole('button', configure));
  await waitFor(() =>
    expect(mocks.operation.start).toHaveBeenCalledWith({
      kind: 'configure',
      target: 'claude-code',
      claudeCode: { key: { kind: 'none' } },
    }),
  );
  expect(screen.queryByTestId('claude-code-setup-form')).toBeNull();
  first.unmount();

  mocks.operation.start.mockReset();
  mocks.claudeCodePlan.data = {
    configPath: '/home/me/.claude/settings.json',
    keyChoices: [{ id: 'k1', label: 'Laptop' }],
  };
  render(<AgentDetailPage target="claude-code" />);
  fireEvent.click(screen.getByRole('button', configure));
  // Submitting without a choice never falls back to the first key.
  fireEvent.submit(await screen.findByTestId('claude-code-setup-form'));
  expect(await screen.findByText(/Choose the API key|请选择/u)).toBeTruthy();
  expect(mocks.operation.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('combobox', { name: /^(API key|API Key)$/u }));
  fireEvent.click(await screen.findByRole('option', { name: 'Laptop' }));
  fireEvent.submit(screen.getByTestId('claude-code-setup-form'));
  await waitFor(() =>
    expect(mocks.operation.start).toHaveBeenCalledWith({
      kind: 'configure',
      target: 'claude-code',
      claudeCode: { key: { kind: 'existing', id: 'k1' } },
    }),
  );
});
