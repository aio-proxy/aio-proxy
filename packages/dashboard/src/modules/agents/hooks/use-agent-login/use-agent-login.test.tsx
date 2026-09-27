import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useAgentLogin } from './use-agent-login';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';

const mocks = rs.hoisted(() => ({
  snapshotCalls: 0,
  pending: true,
  expiresIn: 600_000,
  active: true,
  deviceId: '3f1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c',
  decision: 'approved',
  decidedElsewhere: undefined as 'approved' | 'denied' | undefined,
}));

rs.mock('../../services/agents-service', () => ({
  agentPendingLoginQueryOptions: (installationId: string) => ({
    queryKey: ['agents', 'installations', installationId, 'pending'],
    refetchInterval: 500,
    queryFn: async () => ({
      authorization: !mocks.pending
        ? null
        : {
            status: 'pending',
            deviceId: mocks.deviceId,
            target: 'opencode',
            installationId,
            adapterVersion: '1.0.0',
            expiresAt: new Date(Date.now() + mocks.expiresIn).toISOString(),
            permissions: ['catalog', 'inference'],
          },
      userCode: mocks.pending ? 'WXYZ-2345' : null,
      decided:
        mocks.decidedElsewhere === undefined ? null : { deviceId: mocks.deviceId, status: mocks.decidedElsewhere },
    }),
  }),
  agentsSnapshotQueryOptions: () => ({
    queryKey: ['agents'],
    queryFn: async () => {
      mocks.snapshotCalls += 1;
      return {
        localSetup: 'available',
        deviceAuthorization: 'available',
        adapterVersion: '1.0.0',
        // The credential is issued on the Agent's next token poll, so it turns active a little later.
        installations: [
          {
            installationId: INSTALLATION,
            target: 'opencode',
            adapterVersion: '1.0.0',
            createdAt: '2026-09-01T00:00:00.000Z',
            lastAuthorizedAt: '2026-09-01T00:00:00.000Z',
            authorization: mocks.active && mocks.snapshotCalls >= 2 ? 'active' : 'expired',
            accessExpiresAt: null,
          },
        ],
      };
    },
  }),
  decideAgentLogin: async () => ({ status: mocks.decision }),
}));

test('after approving, the snapshot keeps refreshing until the installation is active', async () => {
  const client = new QueryClient();
  const { result } = renderHook(() => useAgentLogin(INSTALLATION), {
    wrapper: ({ children }: React.PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(result.current.userCode).toBe('WXYZ-2345'));
  act(() => result.current.decide('approve'));
  await waitFor(() => expect(mocks.snapshotCalls).toBeGreaterThanOrEqual(2), { timeout: 6_000 });
  const settledAt = mocks.snapshotCalls;
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(mocks.snapshotCalls).toBe(settledAt);
}, 15_000);

test('a request approved on another page also refreshes the snapshot until the installation is active', async () => {
  mocks.snapshotCalls = 0;
  mocks.pending = true;
  const client = new QueryClient();
  const { result } = renderHook(() => useAgentLogin(INSTALLATION), {
    wrapper: ({ children }: React.PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(result.current.userCode).toBe('WXYZ-2345'));
  // The code-entry page approves it; this hook never records a decision of its own.
  mocks.pending = false;
  await waitFor(() => expect(result.current.pending).toBeUndefined(), { timeout: 5_000 });
  await waitFor(() => expect(mocks.snapshotCalls).toBeGreaterThanOrEqual(2), { timeout: 6_000 });
}, 20_000);

test('an approval the Agent never redeems stops refreshing once the request would have expired', async () => {
  mocks.snapshotCalls = 0;
  mocks.pending = true;
  mocks.active = false;
  mocks.expiresIn = 1_500;
  const client = new QueryClient();
  const { result } = renderHook(() => useAgentLogin(INSTALLATION), {
    wrapper: ({ children }: React.PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(result.current.userCode).toBe('WXYZ-2345'));
  act(() => result.current.decide('approve'));
  await waitFor(() => expect(mocks.snapshotCalls).toBeGreaterThanOrEqual(1), { timeout: 3_000 });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const stoppedAt = mocks.snapshotCalls;
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(mocks.snapshotCalls).toBe(stoppedAt);
  mocks.active = true;
  mocks.expiresIn = 600_000;
}, 20_000);

test('after a denial, a retried login is offered again and its outcome elsewhere is not the old denial', async () => {
  mocks.pending = true;
  mocks.decision = 'denied';
  const client = new QueryClient();
  const { result } = renderHook(() => useAgentLogin(INSTALLATION), {
    wrapper: ({ children }: React.PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(result.current.pending).toBeDefined());
  act(() => result.current.decide('deny'));
  await waitFor(() => expect(result.current.decision).toBe('denied'));
  expect(result.current.pending).toBeUndefined();
  // The Agent retries, creating a new challenge for the same installation.
  mocks.deviceId = '9a1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c';
  await waitFor(() => expect(result.current.pending?.deviceId).toBe(mocks.deviceId), { timeout: 5_000 });
  expect(result.current.decision).toBeUndefined();
  // The retried request is approved on another page, so the old denial must not come back.
  mocks.snapshotCalls = 0;
  mocks.pending = false;
  await waitFor(() => expect(result.current.pending).toBeUndefined(), { timeout: 5_000 });
  expect(result.current.decision).toBeUndefined();
  await waitFor(() => expect(mocks.snapshotCalls).toBeGreaterThanOrEqual(1), { timeout: 6_000 });
  mocks.pending = true;
  mocks.decision = 'approved';
  mocks.deviceId = '3f1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c';
}, 20_000);

test('a request denied on another page shows the denial and does not poll the snapshot', async () => {
  mocks.snapshotCalls = 0;
  mocks.pending = true;
  const client = new QueryClient();
  const { result } = renderHook(() => useAgentLogin(INSTALLATION), {
    wrapper: ({ children }: React.PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(result.current.pending).toBeDefined());
  mocks.pending = false;
  mocks.decidedElsewhere = 'denied';
  await waitFor(() => expect(result.current.decision).toBe('denied'), { timeout: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(mocks.snapshotCalls).toBe(0);
  mocks.pending = true;
  mocks.decidedElsewhere = undefined;
}, 20_000);
