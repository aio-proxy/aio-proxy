import type { AgentInstallationSummary, AgentLocalState, AgentsSnapshot } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { agentInstallations, primaryAgentAction } from './agent-state';

const local = (status: AgentLocalState['status'], extra: Partial<AgentLocalState> = {}): AgentLocalState => ({
  target: 'opencode',
  host: { detected: true, support: 'supported' },
  status,
  ...extra,
});

test('the primary action moves each repairable state forward and leaves CLI-only states alone', () => {
  expect(primaryAgentAction(local('not_configured'))).toBe('configure');
  expect(primaryAgentAction(local('outdated'))).toBe('update');
  expect(primaryAgentAction(local('modified'))).toBe('repair');
  expect(primaryAgentAction(local('configured', { endpointMatches: false }))).toBe('repair');
  expect(primaryAgentAction(local('configured'))).toBe('reconfigure');
  expect(primaryAgentAction(local('conflict'))).toBeUndefined();
  expect(primaryAgentAction(local('recovery_required'))).toBeUndefined();
  expect(primaryAgentAction(local('not_installed'))).toBeUndefined();
  expect(primaryAgentAction(undefined)).toBeUndefined();
});

const installation = (installationId: string): AgentInstallationSummary => ({
  installationId,
  target: 'opencode',
  adapterVersion: '1.0.0',
  createdAt: '2026-09-01T00:00:00.000Z',
  lastAuthorizedAt: '2026-09-01T00:00:00.000Z',
  authorization: 'active',
  accessExpiresAt: null,
});

test('authorizations are marked orphaned only when local state is visible', () => {
  const current = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
  const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const snapshot: AgentsSnapshot = {
    localSetup: 'available',
    deviceAuthorization: 'available',
    adapterVersion: '1.0.0',
    installations: [installation(current), installation(other), { ...installation(other), target: 'pi' }],
    local: [local('configured', { installationId: current })],
  };
  expect(agentInstallations(snapshot, 'opencode').map((row) => row.local)).toEqual(['configured', 'orphaned']);
  const { local: _local, ...remote } = snapshot;
  expect(agentInstallations({ ...remote, localSetup: 'remote_request' }, 'opencode').map((row) => row.local)).toEqual([
    undefined,
    undefined,
  ]);
});
