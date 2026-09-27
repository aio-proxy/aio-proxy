import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useAgentLogin } from './use-agent-login';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';

const mocks = rs.hoisted(() => ({ snapshotCalls: 0 }));

rs.mock('../../services/agents-service', () => ({
  agentPendingLoginQueryOptions: (installationId: string) => ({
    queryKey: ['agents', 'installations', installationId, 'pending'],
    queryFn: async () => ({
      authorization: {
        status: 'pending',
        deviceId: '3f1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c',
        target: 'opencode',
        installationId,
        adapterVersion: '1.0.0',
        expiresAt: '2026-09-26T00:10:00.000Z',
        permissions: ['catalog', 'inference'],
      },
      userCode: 'WXYZ-2345',
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
            authorization: mocks.snapshotCalls >= 2 ? 'active' : 'expired',
            accessExpiresAt: null,
          },
        ],
      };
    },
  }),
  decideAgentLogin: async () => ({ status: 'approved' }),
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
