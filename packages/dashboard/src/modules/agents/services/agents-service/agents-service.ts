import type {
  AgentAuthorizationDetails,
  AgentOperationRequest,
  AgentOperationState,
  AgentsSnapshot,
  CodexSetupPlan,
} from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';

import type { DashboardClientResponse } from '@/lib/dashboard-client';
import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

const OPERATION_POLL_MS = 1_000;
const LOGIN_POLL_MS = 2_000;

export class AgentsRequestError extends Error {
  override name = 'AgentsRequestError';

  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`agents request failed: ${status} ${code}`);
  }
}

const requireOk = async <T>(response: DashboardClientResponse): Promise<T> => {
  const body = (await response.json().catch(() => ({}))) as { readonly error?: unknown };
  if (!response.ok)
    throw new AgentsRequestError(response.status, typeof body.error === 'string' ? body.error : 'request_failed');
  return body as T;
};

const agents = dashboardClient.dashboard.api.agents;

export const agentsSnapshotQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.agents,
    queryFn: async (): Promise<AgentsSnapshot> => requireOk(await agents.$get()),
  });

const isFinished = (state: AgentOperationState | undefined): boolean =>
  state?.status === 'succeeded' || state?.status === 'failed';

export const agentOperationQueryOptions = (operationId: string) =>
  queryOptions({
    queryKey: queryKeys.agentOperation(operationId),
    queryFn: async (): Promise<AgentOperationState> =>
      requireOk(await agents.operations[':operationId'].$get({ param: { operationId } })),
    refetchInterval: (query) => (isFinished(query.state.data) ? false : OPERATION_POLL_MS),
  });

export const agentCodexPlanQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.agentCodexPlan,
    queryFn: async (): Promise<CodexSetupPlan> => requireOk(await agents.codex.plan.$get()),
    staleTime: 0,
  });

export const agentPendingLoginQueryOptions = (installationId: string) =>
  queryOptions({
    queryKey: queryKeys.agentPendingLogin(installationId),
    queryFn: async (): Promise<{ readonly authorization: AgentAuthorizationDetails | null }> =>
      requireOk(await agents.installations[':installationId'].pending.$get({ param: { installationId } })),
    refetchInterval: (query) => (query.state.data?.authorization?.status === 'pending' ? false : LOGIN_POLL_MS),
  });

export const startAgentOperation = async (request: AgentOperationRequest): Promise<AgentOperationState> =>
  requireOk(await agents.operations.$post({ json: request }));

export const decideAgentOperation = async (
  operationId: string,
  decision: 'approve' | 'deny' | 'cancel',
): Promise<AgentOperationState> => {
  const routes = agents.operations[':operationId'];
  const param = { param: { operationId } };
  const response =
    decision === 'approve'
      ? await routes.approve.$post(param)
      : decision === 'deny'
        ? await routes.deny.$post(param)
        : await routes.cancel.$post(param);
  return requireOk(response);
};

/** Decides an Agent-initiated login from the detail page; same endpoint as the code-entry page. */
export const decideAgentLogin = async (
  deviceId: string,
  decision: 'approve' | 'deny',
): Promise<{ readonly status: 'approved' | 'denied' | 'expired' | 'consumed' }> => {
  const routes = dashboardClient.dashboard.api['agent-authorizations'][':deviceId'];
  const response =
    decision === 'approve'
      ? await routes.approve.$post({ param: { deviceId } })
      : await routes.deny.$post({ param: { deviceId } });
  return requireOk(response);
};

export const revokeAgentInstallation = async (
  installationId: string,
): Promise<{ readonly installationId: string; readonly status: string }> =>
  requireOk(await agents[':installationId'].revoke.$post({ param: { installationId } }));
