import { beforeEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AgentAuthorizationPage } from './agent-authorization-page';

const mocks = rs.hoisted(() => ({ approve: rs.fn(), deny: rs.fn(), resolve: rs.fn() }));
rs.mock('@aio-proxy/i18n', () => ({
  m: {
    'dashboard.agent_authorization.title': () => 'Authorize aio-proxy',
    'dashboard.agent_authorization.instructions': () => 'Enter the code shown by your Agent.',
    'dashboard.agent_authorization.code_label': () => 'Authorization code',
    'dashboard.agent_authorization.code_placeholder': () => 'ABCD-EFGH',
    'dashboard.agent_authorization.code_invalid': () => 'Enter the eight-character code.',
    'dashboard.agent_authorization.permissions_title': () => 'Requested access',
    'dashboard.agent_authorization.permission_catalog': () => 'Read the model catalog',
    'dashboard.agent_authorization.permission_inference': () => 'Run model inference',
    'dashboard.agent_authorization.target': () => 'Agent',
    'dashboard.agent_authorization.installation': () => 'Installation ID',
    'dashboard.agent_authorization.version': () => 'Adapter version',
    'dashboard.agent_authorization.expires': () => 'Expires',
    'dashboard.agent_authorization.resolve': () => 'Continue',
    'dashboard.agent_authorization.approve': () => 'Approve',
    'dashboard.agent_authorization.deny': () => 'Deny',
    'dashboard.agent_authorization.pending': () => 'Waiting for your decision.',
    'dashboard.agent_authorization.approved': () => 'Authorization approved.',
    'dashboard.agent_authorization.denied': () => 'Authorization denied.',
    'dashboard.agent_authorization.expired': () => 'This authorization code expired.',
    'dashboard.agent_authorization.consumed': () => 'This authorization code was already used.',
    'dashboard.agent_authorization.password_required': () => 'Set a Dashboard password.',
    'dashboard.agent_authorization.network_error': () => 'aio-proxy is unavailable.',
    'dashboard.agent_authorization.retry': () => 'Use another code',
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

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.approve.mockReset();
  mocks.deny.mockReset();
  window.history.replaceState({}, '', '/dashboard/agents/authorize');
});

test('consumes a fragment only after the authenticated page mounts and shows no credential', async () => {
  window.history.replaceState({}, '', '/dashboard/agents/authorize#code=abcd-efgh');
  mocks.resolve.mockResolvedValue(PENDING);
  const authGate = render(<div>Dashboard sign in</div>);
  expect(window.location.pathname).toBe('/dashboard/agents/authorize');
  expect(window.location.hash).toBe('#code=abcd-efgh');
  authGate.unmount();
  const view = renderPage();
  expect(screen.getByLabelText(/code/i)).toHaveValue('ABCD-EFGH');
  expect(window.location.pathname).toBe('/dashboard/agents/authorize');
  expect(window.location.hash).toBe('');
  fireEvent.click(screen.getByRole('button', { name: /continue|resolve/i }));
  expect(await screen.findByText('opencode')).toBeInTheDocument();
  expect(screen.getByText(PENDING.installationId)).toBeInTheDocument();
  expect(screen.getByText('1.2.3')).toBeInTheDocument();
  expect(screen.getByText(/model catalog/i)).toBeInTheDocument();
  expect(screen.getByText(/inference/i)).toBeInTheDocument();
  expect(view.container.textContent).not.toMatch(/aio_agent_|device[_-]code/iu);
});

test('approves and denies only the resolved opaque device id', async () => {
  mocks.resolve.mockResolvedValue(PENDING);
  mocks.approve.mockResolvedValue({ status: 'approved' });
  mocks.deny.mockResolvedValue({ status: 'denied' });
  renderPage();
  fireEvent.change(screen.getByLabelText(/code/i), { target: { value: 'ABCD-EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: /continue|resolve/i }));
  await screen.findByText('opencode');
  fireEvent.click(screen.getByRole('button', { name: /approve/i }));
  await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(PENDING.deviceId));
  expect(await screen.findByText(/approved/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /retry|another/i }));
  fireEvent.change(screen.getByLabelText(/code/i), { target: { value: 'ABCD-EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: /continue|resolve/i }));
  await screen.findByText('opencode');
  fireEvent.click(screen.getByRole('button', { name: /deny/i }));
  await waitFor(() => expect(mocks.deny).toHaveBeenCalledWith(PENDING.deviceId));
});

test.each([
  ['approved', /approved/i],
  ['denied', /denied/i],
  ['expired', /expired/i],
  ['consumed', /already used/i],
] as const)('renders the %s terminal state returned by resolve', async (status, message) => {
  mocks.resolve.mockResolvedValue({ status });
  renderPage();
  fireEvent.change(screen.getByLabelText(/code/i), { target: { value: 'ABCD-EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: /continue|resolve/i }));
  expect(await screen.findByText(message)).toBeInTheDocument();
});
