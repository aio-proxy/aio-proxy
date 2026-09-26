import type { AgentOperationState, AgentsSnapshot } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

import { useAgentOperation } from './use-agent-operation';

const waiting: AgentOperationState = {
  operationId: '3f1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c',
  target: 'codex',
  kind: 'configure',
  status: 'awaiting_approval',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  userCode: 'ABCD-EFGH',
  expiresAt: '2026-09-26T00:10:00.000Z',
};

const mocks = rs.hoisted(() => ({
  start: rs.fn(),
  snapshot: {} as { data?: AgentsSnapshot },
}));

rs.mock('../use-agents-snapshot', () => ({ useAgentsSnapshot: () => mocks.snapshot }));
rs.mock('../../services/agents-service', () => ({
  agentOperationQueryOptions: (operationId: string) => ({
    queryKey: ['agents', 'operations', operationId],
    queryFn: async () => waiting,
  }),
  decideAgentOperation: rs.fn(),
  startAgentOperation: mocks.start,
}));

const wrapper = ({ children }: React.PropsWithChildren) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

test('a page reloaded mid-approval adopts the unfinished operation instead of starting another', async () => {
  mocks.snapshot.data = {
    localSetup: 'available',
    deviceAuthorization: 'available',
    adapterVersion: '1.0.0',
    installations: [],
    local: [],
    operations: [waiting, { ...waiting, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'remove' }],
  };
  const { result } = renderHook(() => useAgentOperation('codex', ['configure', 'restore_migration']), { wrapper });
  await waitFor(() => expect(result.current.state).toEqual(waiting));
  expect(result.current.adopted).toBe(true);
  expect(result.current.busy).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled();

  const other = renderHook(() => useAgentOperation('grok', ['configure']), { wrapper });
  expect(other.result.current.state).toBeUndefined();
});
