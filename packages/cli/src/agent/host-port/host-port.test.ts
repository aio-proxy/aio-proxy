import { expect, mock, test } from 'bun:test';

import { AgentOperationError } from '@aio-proxy/server';
import type { AgentTarget } from '@aio-proxy/types';

import type { AgentCommandDeps } from '../agent';
import type { CodexDashboardDeps, CodexListResult } from '../codex';
import type { AgentHost, AgentLocation } from '../hosts';
import type { LocalIntegrationStatus } from '../managed-installation';
import { classifyAgentError, createAgentHostPort } from './host-port';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const ENDPOINT = 'http://127.0.0.1:9317';

const marker = (agent: AgentTarget, adapterVersion: string) => ({
  format: 1 as const,
  managedBy: 'aio-proxy' as const,
  agent,
  installationId: INSTALLATION,
  adapterVersion,
  endpoint: `${ENDPOINT}/`,
});

const host = (target: AgentTarget, detected: boolean): AgentHost => ({
  target,
  detected,
  ...(detected ? { executable: `/usr/bin/${target}`, version: '99.0.0' } : {}),
  minimumVersion: '1.0.0',
  support: detected ? 'supported' : 'unknown',
});

function portFixture(options: { readonly codexRecovery?: boolean; readonly codexDetected?: boolean } = {}) {
  let opencode: LocalIntegrationStatus = { integration: 'absent', catalog: 'missing' };
  const install = mock(async () => {
    opencode = { integration: 'managed', marker: marker('opencode', '2.0.0'), entry: 'present', catalog: 'fresh' };
    return 'installed' as const;
  });
  const codexList: CodexListResult = {
    target: 'codex',
    integration: 'static-config',
    configPath: '/home/me/.codex/config.toml',
    activeProviderId: 'openai',
    status: 'absent',
    connection: 'not_checked',
    changedPaths: [],
  };
  const command = {
    detectHost: async (target: AgentTarget) => host(target, target !== 'pi'),
    resolveLocation: async (target: AgentTarget): Promise<AgentLocation> => ({
      target,
      hostRoot: `/home/me/.${target}`,
      managedDir: `/home/me/.${target}/aio-proxy`,
    }),
    inspect: async (location: AgentLocation): Promise<LocalIntegrationStatus> =>
      location.target === 'opencode'
        ? opencode
        : { integration: 'managed', marker: marker(location.target, '1.0.0'), entry: 'present', catalog: 'fresh' },
    resolveEndpoint: async () => ENDPOINT,
    install,
    readSnapshot: async () => {
      throw new TypeError('offline');
    },
    readAssets: async () => new Map(),
    adapterVersion: '2.0.0',
    randomUUID: () => INSTALLATION,
    now: () => 0,
    codex: { list: async () => codexList },
    grok: {
      inspect: async () => ({
        integrationKind: 'auth-command',
        integration: 'managed',
        marker: marker('grok', '2.0.0'),
        configuration: 'modified',
        fields: [],
      }),
    },
  } as unknown as AgentCommandDeps;
  const codex = {
    location: { configPath: codexList.configPath },
    pendingRecovery: async () => options.codexRecovery === true,
  } as unknown as CodexDashboardDeps;
  const port = createAgentHostPort({
    command,
    codex: () => codex,
    codexDetected: () => options.codexDetected ?? true,
  });
  return { port, install };
}

test('inspect reports each Agent in dashboard order with its local status', async () => {
  const { port } = portFixture();
  const rows = await port.inspect();
  expect(rows.map((row) => [row.target, row.status])).toEqual([
    ['opencode', 'not_configured'],
    ['pi', 'not_installed'],
    ['omp', 'outdated'],
    ['codex', 'not_configured'],
    ['grok', 'modified'],
  ]);
  expect(rows.find((row) => row.target === 'grok')).toMatchObject({
    installationId: INSTALLATION,
    configPath: '/home/me/.grok',
  });
});

test('pending Codex recovery outranks every other Codex status', async () => {
  const rows = await portFixture({ codexRecovery: true }).port.inspect();
  expect(rows.find((row) => row.target === 'codex')?.status).toBe('recovery_required');
});

test('plugin configure returns the new installation and the login step', async () => {
  const { port, install } = portFixture();
  const events = { signal: new AbortController().signal, onDevice: () => undefined };
  const result = await port.configure('opencode', undefined, events);
  expect(install).toHaveBeenCalledTimes(1);
  expect(result).toEqual({
    target: 'opencode',
    status: 'installed',
    installationId: INSTALLATION,
    configPath: '/home/me/.opencode/aio-proxy',
    loginCommand: 'opencode auth login --provider aio-proxy',
  });
});

test('configure of a missing host fails with a classified code', async () => {
  const { port } = portFixture({ codexDetected: false });
  const events = { signal: new AbortController().signal, onDevice: () => undefined };
  await expect(port.configure('pi', undefined, events)).rejects.toMatchObject({ code: 'host_missing' });
  await expect(port.codexPlan()).rejects.toMatchObject({ code: 'host_missing' });
});

test('classifyAgentError maps known CLI failures and leaves the rest unknown', () => {
  expect(classifyAgentError(Object.assign(new Error('access_denied'), { code: 'access_denied' }))?.code).toBe(
    'authorization_denied',
  );
  expect(classifyAgentError(new Error('CODEX_SETUP_ENDPOINT_CHANGED'))?.code).toBe('endpoint_changed');
  expect(classifyAgentError(new Error('Codex provider aio is occupied'))?.code).toBe('occupied_provider_id');
  expect(classifyAgentError(new AgentOperationError('plan_stale'))?.code).toBe('plan_stale');
  expect(classifyAgentError(new Error('disk full'))).toBeUndefined();
});
