import { canonicalizeLoopbackHost } from '@aio-proxy/core';
import {
  AgentAdminSnapshotSchema,
  AgentRevokeResponseSchema,
  type AgentAdminSnapshot,
  type AgentRevokeStatus,
} from '@aio-proxy/types';

import { controlBaseUrl, resolveControlAddress } from '../../control-plane';

export const connectHost = (host: string): string => {
  if (host === '0.0.0.0' || host === '*') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  const canonical = canonicalizeLoopbackHost(host);
  if (canonical === undefined) throw new Error('Agent integrations require a loopback aio-proxy endpoint');
  return canonical;
};

export const resolveAgentEndpoint = async (): Promise<string> => {
  const { host, port } = await resolveControlAddress({});
  return controlBaseUrl(connectHost(host), port);
};

export const readAgentAdminSnapshot = async (
  endpoint: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<AgentAdminSnapshot> => {
  const response = await fetchFn(`${endpoint}/admin/agent-installations`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`agent admin snapshot failed (${response.status})`);
  return AgentAdminSnapshotSchema.parse(await response.json());
};

export const revokeAgentInstallation = async (
  endpoint: string,
  installationId: string,
  fetchFn: typeof fetch = globalThis.fetch,
  budget?: { readonly deadline: number; readonly signal: AbortSignal },
): Promise<AgentRevokeStatus> => {
  const id = AgentRevokeResponseSchema.shape.installationId.parse(installationId);
  const timeoutMs = budget === undefined ? 3_000 : Math.max(0, budget.deadline - Date.now());
  if (timeoutMs === 0) throw new Error('agent admin revoke timed out');
  budget?.signal.throwIfAborted();
  const response = await fetchFn(`${endpoint}/admin/agent-installations/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(budget === undefined ? [] : [budget.signal])]),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`agent admin revoke failed (${response.status})`);
  const parsed = AgentRevokeResponseSchema.parse(await response.json());
  if (parsed.installationId !== id) throw new Error('agent admin revoke installation mismatch');
  return parsed.status;
};
