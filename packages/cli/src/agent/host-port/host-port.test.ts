import { expect, mock, test } from 'bun:test';

import { AgentOperationError } from '@aio-proxy/server';
import type { AgentTarget } from '@aio-proxy/types';

import type { AgentCommandDeps } from '../agent';
import type { ClaudeCodeKeySelector, ClaudeCodeListResult } from '../claude-code';
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

function portFixture(
  options: {
    readonly codexRecovery?: boolean;
    readonly codexDetected?: boolean;
    readonly failAfterInstall?: boolean;
    readonly grokNewer?: boolean;
    readonly locationError?: Error;
    readonly grokUninstalled?: boolean;
    readonly claudeCodeDetected?: boolean;
    readonly claudeCodeConfigure?: (selectKey: ClaudeCodeKeySelector | undefined) => Promise<unknown>;
  } = {},
) {
  let installed = false;
  let opencode: LocalIntegrationStatus = { integration: 'absent', catalog: 'missing' };
  const install = mock(async () => {
    opencode = { integration: 'managed', marker: marker('opencode', '2.0.0'), entry: 'present', catalog: 'fresh' };
    installed = true;
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
  const claudeCodeList: ClaudeCodeListResult = {
    target: 'claude-code',
    integration: 'static-config',
    configPath: '/home/me/.claude/settings.json',
    status: 'absent',
    connection: 'not_checked',
    changedPaths: [],
  };
  const command = {
    detectHost: async (target: AgentTarget) => {
      if (installed && options.failAfterInstall === true && target === 'omp') throw new Error('probe failed');
      return host(target, target !== 'pi' && !(target === 'grok' && options.grokUninstalled === true));
    },
    resolveLocation: async (target: AgentTarget): Promise<AgentLocation> => {
      if (options.locationError !== undefined && target === 'opencode') throw options.locationError;
      return {
        target,
        hostRoot: `/home/me/.${target}`,
        managedDir: `/home/me/.${target}/aio-proxy`,
      };
    },
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
    claudeCode: {
      detected: () => options.claudeCodeDetected ?? true,
      list: async () => claudeCodeList,
      configure: options.claudeCodeConfigure,
      plan: async () => ({ configPath: claudeCodeList.configPath, keyChoices: [{ id: 'choice-1', label: 'Laptop' }] }),
    },
    grok: {
      inspect: async () => ({
        integrationKind: 'auth-command',
        integration: options.grokNewer === true ? 'newer' : 'managed',
        marker: marker('grok', options.grokNewer === true ? '3.0.0' : '2.0.0'),
        configuration: options.grokNewer === true ? 'current' : 'modified',
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
    ['claude-code', 'not_configured'],
  ]);
  expect(rows.find((row) => row.target === 'grok')).toMatchObject({
    installationId: INSTALLATION,
    configPath: '/home/me/.grok',
  });
});

test('a Grok integration written by a newer adapter is a conflict, not a configurable install', async () => {
  const rows = await portFixture({ grokNewer: true }).port.inspect();
  expect(rows.find((row) => row.target === 'grok')?.status).toBe('conflict');
});

test('a Grok config left behind after its binary is uninstalled keeps a removable status', async () => {
  const rows = await portFixture({ grokUninstalled: true }).port.inspect();
  expect(rows.find((row) => row.target === 'grok')).toMatchObject({
    host: { detected: false },
    status: 'modified',
    installationId: INSTALLATION,
  });
});

test('pending Codex recovery outranks every other Codex status', async () => {
  const rows = await portFixture({ codexRecovery: true }).port.inspect();
  expect(rows.find((row) => row.target === 'codex')?.status).toBe('recovery_required');
});

test('plugin configure returns the new installation and the login step', async () => {
  const { port, install } = portFixture();
  const events = { signal: new AbortController().signal, onDevice: () => undefined };
  const result = await port.configure('opencode', {}, events);
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
  await expect(port.configure('pi', {}, events)).rejects.toMatchObject({ code: 'host_missing' });
  await expect(port.codexPlan()).rejects.toMatchObject({ code: 'host_missing' });
});

test('classifyAgentError maps known CLI failures and leaves the rest unknown', () => {
  expect(classifyAgentError(Object.assign(new Error('access_denied'), { code: 'access_denied' }))?.code).toBe(
    'authorization_denied',
  );
  expect(classifyAgentError(new Error('CODEX_SETUP_ENDPOINT_CHANGED'))?.code).toBe('endpoint_changed');
  expect(classifyAgentError(new Error('CLAUDE_CODE_ENDPOINT_CHANGED'))?.code).toBe('endpoint_changed');
  expect(classifyAgentError(new Error('Codex provider aio is occupied'))?.code).toBe('occupied_provider_id');
  expect(classifyAgentError(new AgentOperationError('plan_stale'))?.code).toBe('plan_stale');
  expect(classifyAgentError(Object.assign(new Error('denied'), { code: 'EACCES' }))?.code).toBe('path_unavailable');
  expect(classifyAgentError(new Error('Timed out waiting for process lock: /home/me/.grok/.lock'))?.code).toBe(
    'locked',
  );
  // "BLOCKED" contains "LOCK" but is a blocked revocation, not a held lock.
  expect(classifyAgentError(new Error('CODEX_AUTH_REVOKE_BLOCKED'))?.code).toBe('recovery_required');
  // Configure refuses to overwrite user-edited managed fields; the user must remove and configure again.
  expect(classifyAgentError(new Error('Codex managed fields changed: model_providers.aio.base_url'))?.code).toBe(
    'configuration_modified',
  );
  expect(classifyAgentError(new Error('Grok configuration modified: auth.auth_provider_command'))?.code).toBe(
    'configuration_modified',
  );
  expect(classifyAgentError(new Error('Claude Code managed fields changed: env.ANTHROPIC_AUTH_TOKEN'))?.code).toBe(
    'configuration_modified',
  );
  expect(classifyAgentError(new Error('disk full'))).toBeUndefined();
});

test('a configure that wrote its files stays successful when the follow-up lookup fails', async () => {
  const { port, install } = portFixture({ failAfterInstall: true });
  const events = { signal: new AbortController().signal, onDevice: () => undefined };
  const result = await port.configure('opencode', {}, events);
  expect(install).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ target: 'opencode', status: 'installed' });
  expect(result.installationId).toBeUndefined();
});

test('an Agent location that became unusable fails as path_unavailable before writing', async () => {
  const { port, install } = portFixture({ locationError: new Error('opencode config path must be absolute') });
  const events = { signal: new AbortController().signal, onDevice: () => undefined };
  await expect(port.configure('opencode', {}, events)).rejects.toMatchObject({ code: 'path_unavailable' });
  await expect(port.remove('opencode', events)).rejects.toMatchObject({ code: 'path_unavailable' });
  expect(install).not.toHaveBeenCalled();
});

test('a cancelled operation writes nothing', async () => {
  const { port, install } = portFixture();
  const controller = new AbortController();
  controller.abort();
  const events = { signal: controller.signal, onDevice: () => undefined };
  await expect(port.configure('opencode', {}, events)).rejects.toMatchObject({ code: 'cancelled' });
  await expect(port.remove('opencode', events)).rejects.toMatchObject({ code: 'cancelled' });
  await expect(port.restoreCodexMigration(INSTALLATION, events)).rejects.toMatchObject({ code: 'cancelled' });
  expect(install).not.toHaveBeenCalled();
});

test('claude-code configure uses the submitted key choice and returns a token-free result', async () => {
  let chosen: unknown;
  const { port } = portFixture({
    claudeCodeConfigure: async (selectKey) => {
      chosen = await selectKey?.([{ id: 'choice-1', label: 'Laptop' }]);
      return {
        target: 'claude-code',
        integration: 'static-config',
        status: 'configured',
        configPath: '/home/me/.claude/settings.json',
        baseUrl: ENDPOINT,
        credential: 'existing',
        connection: 'ok',
      };
    },
  });
  const events = { signal: new AbortController().signal, onDevice: () => undefined };
  const key = { kind: 'existing', id: 'choice-1' } as const;
  expect(await port.configure('claude-code', { claudeCode: { key } }, events)).toEqual({
    target: 'claude-code',
    status: 'configured',
    configPath: '/home/me/.claude/settings.json',
  });
  expect(chosen).toEqual(key);
});

test('a claude-code key choice that went stale is a stale plan, and a missing host blocks the plan', async () => {
  const { port } = portFixture({
    claudeCodeConfigure: async () => {
      throw new Error('CREDENTIAL_SELECTION_STALE');
    },
  });
  const events = { signal: new AbortController().signal, onDevice: () => undefined };
  await expect(port.configure('claude-code', { claudeCode: { key: { kind: 'none' } } }, events)).rejects.toMatchObject({
    code: 'plan_stale',
  });
  expect((await port.claudeCodePlan()).keyChoices).toEqual([{ id: 'choice-1', label: 'Laptop' }]);
  await expect(portFixture({ claudeCodeDetected: false }).port.claudeCodePlan()).rejects.toMatchObject({
    code: 'host_missing',
  });
});
