import { m } from '@aio-proxy/i18n';
import type { AgentIntegrationKind, AgentLocalStatus } from '@aio-proxy/types';

import type { PrimaryAgentAction } from '../agent-state';

const STATUS: Readonly<Record<AgentLocalStatus, () => string>> = {
  not_installed: () => m['dashboard.agents.status.not_installed'](),
  not_configured: () => m['dashboard.agents.status.not_configured'](),
  configured: () => m['dashboard.agents.status.configured'](),
  outdated: () => m['dashboard.agents.status.outdated'](),
  modified: () => m['dashboard.agents.status.modified'](),
  missing: () => m['dashboard.agents.status.missing'](),
  conflict: () => m['dashboard.agents.status.conflict'](),
  recovery_required: () => m['dashboard.agents.status.recovery_required'](),
};

export const statusLabel = (status: AgentLocalStatus | undefined): string =>
  status === undefined ? m['dashboard.agents.status.unknown']() : STATUS[status]();

export const statusHint = (status: AgentLocalStatus, target: string): string | undefined => {
  switch (status) {
    case 'not_installed':
      return m['dashboard.agents.status_hint.not_installed']({ target });
    case 'conflict':
      return m['dashboard.agents.status_hint.conflict']({ target });
    case 'recovery_required':
      return m['dashboard.agents.status_hint.recovery_required']();
    case 'modified':
      return m['dashboard.agents.status_hint.modified']();
    case 'missing':
      return m['dashboard.agents.status_hint.missing']();
    case 'outdated':
      return m['dashboard.agents.status_hint.outdated']();
    default:
      return undefined;
  }
};

export const kindLabel = (kind: AgentIntegrationKind): string => {
  if (kind === 'plugin') return m['dashboard.agents.kind.plugin']();
  if (kind === 'auth-command') return m['dashboard.agents.kind.auth_command']();
  return m['dashboard.agents.kind.static_config']();
};

export const actionLabel = (action: PrimaryAgentAction): string => {
  if (action === 'configure') return m['dashboard.agents.action.configure']();
  if (action === 'update') return m['dashboard.agents.action.update']();
  if (action === 'repair') return m['dashboard.agents.action.repair']();
  return m['dashboard.agents.action.reconfigure']();
};

const ERRORS: Readonly<Record<string, () => string>> = {
  host_missing: () => m['dashboard.agents.error.host_missing'](),
  path_unavailable: () => m['dashboard.agents.error.path_unavailable'](),
  not_configured: () => m['dashboard.agents.error.not_configured'](),
  locked: () => m['dashboard.agents.error.locked'](),
  invalid_provider_id: () => m['dashboard.agents.error.invalid_provider_id'](),
  occupied_provider_id: () => m['dashboard.agents.error.occupied_provider_id'](),
  endpoint_changed: () => m['dashboard.agents.error.endpoint_changed'](),
  authorization_denied: () => m['dashboard.agents.error.authorization_denied'](),
  authorization_expired: () => m['dashboard.agents.error.authorization_expired'](),
  recovery_required: () => m['dashboard.agents.error.recovery_required'](),
  plan_stale: () => m['dashboard.agents.error.plan_stale'](),
  cancelled: () => m['dashboard.agents.error.cancelled'](),
  operation_in_progress: () => m['dashboard.agents.error.operation_in_progress'](),
  unknown: () => m['dashboard.agents.error.unknown'](),
};

/** Operation error codes and request error codes share one message table. */
export const errorMessage = (code: string): string =>
  (ERRORS[code] ?? (() => m['dashboard.agents.error.request_failed']()))();
