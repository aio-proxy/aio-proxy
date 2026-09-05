import type { AgentAuthorizationDetails } from '@aio-proxy/types';

import type { DashboardClientResponse } from '@/lib/dashboard-client';
import { dashboardClient } from '@/lib/dashboard-client';

export class AgentAuthorizationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`agent authorization request failed: ${status} ${code}`);
  }
}

const requireOk = async <T>(response: DashboardClientResponse): Promise<T> => {
  const body = (await response.json().catch(() => ({}))) as { readonly error?: unknown };
  if (!response.ok)
    throw new AgentAuthorizationRequestError(
      response.status,
      typeof body.error === 'string' ? body.error : 'request_failed',
    );
  return body as T;
};

export const resolveAgentAuthorization = async (userCode: string): Promise<AgentAuthorizationDetails> => {
  const response = await dashboardClient.dashboard.api['agent-authorizations'].resolve.$post({
    json: { userCode },
  });
  return requireOk(response);
};

export const decideAgentAuthorization = async (
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
