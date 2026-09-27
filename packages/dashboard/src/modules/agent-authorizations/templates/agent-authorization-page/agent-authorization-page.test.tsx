import { beforeEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AgentAuthorizationPage } from './agent-authorization-page';

const mocks = rs.hoisted(() => ({ approve: rs.fn(), deny: rs.fn(), resolve: rs.fn() }));
rs.mock('@aio-proxy/i18n', () => ({
  m: {
    'dashboard.agent_authorization.title': () => 'Authorize',
    'dashboard.agent_authorization.instructions': () => 'Enter the code shown by your Agent.',
    'dashboard.agent_authorization.code_label': () => 'Authorization code',
    'dashboard.agent_authorization.code_invalid': () => 'Enter the eight-character code.',
    'dashboard.agent_authorization.permissions_title': () => 'Requested access',
    'dashboard.agent_authorization.permission_catalog': () => 'Read the model catalog',
    'dashboard.agent_authorization.permission_inference': () => 'Run model inference',
    'dashboard.agent_authorization.target': () => 'Agent',
    'dashboard.agent_authorization.installation': () => 'Installation ID',
    'dashboard.agent_authorization.version': () => 'Adapter version',
    'dashboard.agent_authorization.expires': () => 'Expires',
    'dashboard.agent_authorization.approve': () => 'Approve',
    'dashboard.agent_authorization.deny': () => 'Deny',
    'dashboard.agent_authorization.pending': () => 'Waiting for your decision.',
    'dashboard.agent_authorization.approved': () => 'Authorization approved.',
    'dashboard.agent_authorization.denied': () => 'Authorization denied.',
    'dashboard.agent_authorization.expired': () => 'This authorization code expired.',
    'dashboard.agent_authorization.consumed': () => 'This authorization code was already used.',
    'dashboard.agent_authorization.password_required': () => 'Set a Dashboard password.',
    'dashboard.agent_authorization.network_error': () => 'aio-proxy is unavailable.',
  },
}));
rs.mock('../../services/agent-authorizations-service', () => ({
  resolveAgentAuthorization: mocks.resolve,
  decideAgentAuthorization: (deviceId: string, decision: 'approve' | 'deny') =>
    decision === 'approve' ? mocks.approve(deviceId) : mocks.deny(deviceId),
}));

const PENDING = {
  status: 'pending',
  deviceId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  target: 'opencode',
  installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  adapterVersion: '1.2.3',
  expiresAt: '2026-08-18T12:10:00.000Z',
  permissions: ['catalog', 'inference'],
} as const;
const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <AgentAuthorizationPage />
    </QueryClientProvider>,
  );

const entry = () => screen.getByRole('textbox', { name: 'Authorization code' }) as HTMLInputElement;
const decisionButtons = () => ({
  approve: screen.getByRole('button', { name: /approve/i }),
  deny: screen.getByRole('button', { name: /deny/i }),
});

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.approve.mockReset();
  mocks.deny.mockReset();
  window.history.replaceState({}, '', '/dashboard/agents/authorize');
});

test('offers disabled deny and approve before any code is entered', async () => {
  renderPage();
  expect(entry().value).toBe('');
  expect(decisionButtons().approve).toBeDisabled();
  expect(decisionButtons().deny).toBeDisabled();
  expect(screen.queryByText('Requested access')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
});

test('resolves automatically when the code is completed', async () => {
  mocks.resolve.mockResolvedValue(PENDING);
  renderPage();
  fireEvent.change(entry(), { target: { value: 'ABCDEFGH' } });
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith('ABCD-EFGH', expect.anything()));
  expect(await screen.findByText('opencode')).toBeInTheDocument();
  expect(screen.getByText(PENDING.installationId)).toBeInTheDocument();
  expect(entry().value).toBe('ABCDEFGH');
  expect(decisionButtons().approve).toBeEnabled();
  expect(decisionButtons().deny).toBeEnabled();
});

test('keeps a link code pre-filled and resolves it through the same flow', async () => {
  window.history.replaceState({}, '', '/dashboard/agents/authorize#code=abcd-efgh');
  mocks.resolve.mockResolvedValue(PENDING);
  const view = renderPage();
  expect(entry().value).toBe('ABCDEFGH');
  expect(window.location.hash).toBe('');
  expect(await screen.findByText('opencode')).toBeInTheDocument();
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith('ABCD-EFGH', expect.anything()));
  expect(screen.getByText(PENDING.installationId)).toBeInTheDocument();
  expect(screen.getByText('1.2.3')).toBeInTheDocument();
  expect(screen.getByText(/model catalog/i)).toBeInTheDocument();
  expect(screen.getByText(/inference/i)).toBeInTheDocument();
  expect(entry()).toBeInTheDocument();
  expect(decisionButtons().approve).toBeEnabled();
  expect(decisionButtons().deny).toBeEnabled();
  expect(view.container.textContent).not.toMatch(/aio_agent_|device[_-]code/iu);
});

test('approves from the footer after the code resolves', async () => {
  mocks.resolve.mockResolvedValue(PENDING);
  mocks.approve.mockResolvedValue({ status: 'approved' });
  renderPage();
  fireEvent.change(entry(), { target: { value: 'ABCDEFGH' } });
  await screen.findByText('opencode');
  fireEvent.click(screen.getByRole('button', { name: /approve/i }));
  await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(PENDING.deviceId));
  expect(await screen.findByText(/approved/i)).toBeInTheDocument();
});

test('denies from the footer after the code resolves', async () => {
  mocks.resolve.mockResolvedValue(PENDING);
  mocks.deny.mockResolvedValue({ status: 'denied' });
  renderPage();
  fireEvent.change(entry(), { target: { value: 'ABCDEFGH' } });
  await screen.findByText('opencode');
  fireEvent.click(screen.getByRole('button', { name: /deny/i }));
  await waitFor(() => expect(mocks.deny).toHaveBeenCalledWith(PENDING.deviceId));
  expect(await screen.findByText(/denied/i)).toBeInTheDocument();
});

test('hides the request and disables the decisions when the resolved code is edited', async () => {
  window.history.replaceState({}, '', '/dashboard/agents/authorize#code=abcd-efgh');
  mocks.resolve.mockResolvedValue(PENDING);
  renderPage();
  await screen.findByText('opencode');
  expect(decisionButtons().approve).toBeEnabled();
  fireEvent.change(entry(), { target: { value: 'ABCDEFG' } });
  expect(screen.queryByText('opencode')).not.toBeInTheDocument();
  expect(decisionButtons().approve).toBeDisabled();
  expect(decisionButtons().deny).toBeDisabled();
  expect(entry().value).toBe('ABCDEFG');
});

test('toasts and keeps the entry when a link code is already finished', async () => {
  window.history.replaceState({}, '', '/dashboard/agents/authorize#code=abcd-efgh');
  mocks.resolve.mockResolvedValue({ status: 'expired' });
  renderPage();
  expect(entry().value).toBe('ABCDEFGH');
  expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  expect(entry()).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
});

test.each([
  ['approved', /approved/i],
  ['denied', /denied/i],
  ['expired', /expired/i],
  ['consumed', /already used/i],
] as const)('keeps the code entry and toasts a %s resolve result', async (status, message) => {
  mocks.resolve.mockResolvedValue({ status });
  renderPage();
  fireEvent.change(entry(), { target: { value: 'ABCDEFGH' } });
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(entry()).toBeInTheDocument();
  expect(screen.queryByText('Requested access')).not.toBeInTheDocument();
});

test('shows an alert when the code cannot be resolved', async () => {
  mocks.resolve.mockRejectedValue(new Error('boom'));
  renderPage();
  fireEvent.change(entry(), { target: { value: 'ABCDEFGH' } });
  expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
  expect(entry()).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
});

test('retries the same code after a failed resolve', async () => {
  mocks.resolve.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(PENDING);
  renderPage();
  fireEvent.change(entry(), { target: { value: 'ABCDEFGH' } });
  expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  // Re-pasting the same complete code must start a fresh resolve; the once-per-code latch must not survive a failure.
  fireEvent.change(entry(), { target: { value: 'abcdefgh' } });
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('opencode')).toBeInTheDocument();
});
