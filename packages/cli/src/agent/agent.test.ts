import { expect, mock, test } from 'bun:test';

import type { AgentAdminSnapshot, AgentInstallationSummary, AgentRevokeStatus, AgentTarget } from '@aio-proxy/types';

import { agentConfigure, agentList, agentRemove, type AgentCommandDeps } from './agent';
import type { AgentHost, AgentLocation } from './hosts';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const ORPHAN_INSTALLATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const installation = (installationId: string): AgentInstallationSummary => ({
  installationId,
  target: installationId === INSTALLATION ? 'opencode' : 'omp',
  adapterVersion: '1.2.3',
  createdAt: '2026-08-18T00:00:00.000Z',
  lastAuthorizedAt: '2026-08-18T00:00:01.000Z',
  authorization: 'active',
  accessExpiresAt: '2026-08-18T00:15:01.000Z',
});

const commandLocation = (target: AgentTarget): AgentLocation => {
  const hostRoot = `/tmp/${target}/${target === 'opencode' ? 'plugins' : 'extensions'}`;
  return {
    target,
    hostRoot,
    managedDir: `${hostRoot}/aio-proxy`,
    ...(target === 'opencode' ? { adjacentEntry: `${hostRoot}/aio-proxy.js` } : {}),
  };
};

function commandFixture(
  options: {
    readonly server?: 'online' | 'offline';
    readonly serverHost?: string;
    readonly target?: AgentTarget;
    readonly hostSupport?: AgentHost['support'];
    readonly hostVersion?: string;
    readonly missingTargets?: readonly AgentTarget[];
    readonly pathFailureTargets?: readonly AgentTarget[];
    readonly deviceAuthorization?: AgentAdminSnapshot['deviceAuthorization'];
    readonly catalogSchemaVersions?: readonly number[];
    readonly revokeStatus?: AgentRevokeStatus;
    readonly revokeError?: Error;
    readonly localInstallationIds?: readonly string[];
    readonly serverInstallations?: readonly AgentInstallationSummary[];
  } = {},
) {
  const missing = new Set(options.missingTargets ?? []);
  const pathFailures = new Set(options.pathFailureTargets ?? []);
  const localIds = options.localInstallationIds ?? (options.target === undefined ? [] : [INSTALLATION]);
  const localByTarget = new Map<AgentTarget, string>();
  if (options.target !== undefined && localIds[0] !== undefined) localByTarget.set(options.target, localIds[0]);
  else
    (['opencode', 'pi', 'omp'] as const).forEach((target, index) => {
      const installationId = localIds[index];
      if (installationId !== undefined) localByTarget.set(target, installationId);
    });
  const events: string[] = [];
  const install = mock(async () => {
    events.push('install');
    return 'installed' as const;
  });
  const remove = mock(async () => {
    events.push('remove');
  });
  const revoke = mock(async () => {
    events.push('revoke');
    if (options.revokeError !== undefined) throw options.revokeError;
    return options.revokeStatus ?? 'revoked';
  });
  const deps: AgentCommandDeps = {
    detectHost: async (target) => ({
      target,
      detected: !missing.has(target),
      ...(missing.has(target)
        ? {}
        : {
            executable: `/usr/local/bin/${target}`,
            version: options.hostVersion ?? '99.0.0',
          }),
      minimumVersion: { opencode: '1.17.10', pi: '0.84.2', omp: '17.3.7' }[target],
      support: missing.has(target) ? 'unknown' : (options.hostSupport ?? 'supported'),
    }),
    resolveLocation: async (target) => {
      if (pathFailures.has(target)) throw new Error(`${target} path unavailable`);
      return commandLocation(target);
    },
    inspect: async (location) => {
      const installationId = localByTarget.get(location.target);
      if (installationId === undefined) return { integration: 'absent', catalog: 'missing' };
      return {
        integration: 'managed',
        catalog: 'fresh',
        marker: {
          format: 1,
          managedBy: 'aio-proxy',
          agent: location.target,
          installationId,
          adapterVersion: '1.2.3',
          endpoint: 'http://127.0.0.1:9317',
        },
      };
    },
    resolveEndpoint: async () => {
      if (options.serverHost !== undefined && options.serverHost !== '127.0.0.1')
        throw new Error('Agent integrations require loopback');
      return 'http://127.0.0.1:9317';
    },
    install,
    remove,
    readSnapshot: async () => {
      if (options.server === 'offline') throw new TypeError('offline');
      return {
        installations: [...(options.serverInstallations ?? [])],
        deviceAuthorization: options.deviceAuthorization ?? 'available',
        catalogSchemaVersions: [...(options.catalogSchemaVersions ?? [1])],
      };
    },
    revoke,
    readAssets: async () => new Map([['index.js', new TextEncoder().encode('adapter')]]),
    adapterVersion: '1.2.3',
    randomUUID: () => INSTALLATION,
    now: () => Date.parse('2026-08-18T00:05:00.000Z'),
  };
  return { deps, events, install, remove, revoke };
}

test('configure installs while an offline server remains an explicit warning', async () => {
  const f = commandFixture({ server: 'offline', target: 'opencode' });
  await expect(agentConfigure('opencode', f.deps)).resolves.toMatchObject({
    target: 'opencode',
    installed: true,
    server: 'unreachable',
    host: { version: '99.0.0', minimumVersion: '1.17.10', support: 'supported' },
    loginCommand: 'opencode auth login --provider aio-proxy',
  });
  expect(f.install).toHaveBeenCalledTimes(1);
});

test('configure returns the host compatibility fields needed for its warning', async () => {
  const f = commandFixture({
    target: 'opencode',
    hostSupport: 'unsupported',
    hostVersion: '1.17.9',
  });
  await expect(agentConfigure('opencode', f.deps)).resolves.toMatchObject({
    host: { version: '1.17.9', minimumVersion: '1.17.10', support: 'unsupported' },
  });
});

test('configure rejects explicit non-loopback bind before writing', async () => {
  const f = commandFixture({ serverHost: '192.0.2.10', target: 'pi' });
  await expect(agentConfigure('pi', f.deps)).rejects.toThrow('loopback');
  expect(f.install).not.toHaveBeenCalled();
});

test('password-required capability warns but does not undo installation', async () => {
  const f = commandFixture({ deviceAuthorization: 'password_required', target: 'omp' });
  await expect(agentConfigure('omp', f.deps)).resolves.toMatchObject({
    installed: true,
    deviceAuthorization: 'password_required',
    loginCommand: '/login aio-proxy',
  });
});

test.each(['revoked', 'expired', 'missing'] as const)(
  'remove deletes validated files after server terminal %s',
  async (status) => {
    const f = commandFixture({ revokeStatus: status, target: 'opencode' });
    await agentRemove('opencode', f.deps);
    expect(f.events).toEqual(['revoke', 'remove']);
  },
);

test('remove leaves files untouched on network failure', async () => {
  const f = commandFixture({ revokeError: new TypeError('offline'), target: 'pi' });
  await expect(agentRemove('pi', f.deps)).rejects.toThrow('offline');
  expect(f.remove).not.toHaveBeenCalled();
});

test('authorizations marks configured and orphaned server identities', async () => {
  const f = commandFixture({
    localInstallationIds: [INSTALLATION],
    serverInstallations: [installation(INSTALLATION), installation(ORPHAN_INSTALLATION)],
  });
  const result = await agentList({ authorizations: true }, f.deps);
  expect(result.authorizations).toEqual([
    expect.objectContaining({ installationId: INSTALLATION, local: 'configured' }),
    expect.objectContaining({ installationId: ORPHAN_INSTALLATION, local: 'orphaned' }),
  ]);
});

test('list --check returns the complete per-target and server capability contract', async () => {
  const f = commandFixture({
    localInstallationIds: [INSTALLATION],
    serverInstallations: [installation(INSTALLATION)],
    deviceAuthorization: 'password_required',
    catalogSchemaVersions: [1],
  });
  const result = await agentList({ check: true }, f.deps);
  expect(result).toMatchObject({
    server: 'reachable',
    deviceAuthorization: 'password_required',
    catalogSchemaVersions: [1],
  });
  expect(result.targets).toContainEqual(
    expect.objectContaining({
      target: 'opencode',
      integration: 'managed',
      endpointMatches: true,
      authorization: 'active',
      schemaCompatibility: 'compatible',
      marker: expect.objectContaining({
        installationId: INSTALLATION,
        adapterVersion: '1.2.3',
        endpoint: 'http://127.0.0.1:9317',
      }),
    }),
  );
});

test('list --check reports a missing authorization and incompatible catalog schema', async () => {
  const f = commandFixture({
    localInstallationIds: [INSTALLATION],
    catalogSchemaVersions: [],
    serverInstallations: [],
  });
  const result = await agentList({ check: true }, f.deps);
  expect(result.targets).toContainEqual(
    expect.objectContaining({
      target: 'opencode',
      authorization: 'missing',
      schemaCompatibility: 'incompatible',
    }),
  );
});

test('local-only list makes authorization and schema checks explicit', async () => {
  const f = commandFixture({ localInstallationIds: [INSTALLATION] });
  const result = await agentList({}, f.deps);
  expect(result.server).toBe('not_checked');
  expect(result.deviceAuthorization).toBeUndefined();
  expect(result.catalogSchemaVersions).toBeUndefined();
  expect(result.targets).toContainEqual(
    expect.objectContaining({
      target: 'opencode',
      endpointMatches: true,
      authorization: 'not_checked',
      schemaCompatibility: 'not_checked',
    }),
  );
});

test('list reports an undetected host as unresolved without resolving its path', async () => {
  const f = commandFixture({ missingTargets: ['opencode'] });
  const result = await agentList({}, f.deps);
  expect(result.targets).toContainEqual(
    expect.objectContaining({
      target: 'opencode',
      integration: 'unresolved',
      reason: 'host_missing',
    }),
  );
});

test('remove fails before revoke when the public host path is unavailable', async () => {
  const f = commandFixture({ target: 'omp', pathFailureTargets: ['omp'] });
  await expect(agentRemove('omp', f.deps)).rejects.toThrow('path unavailable');
  expect(f.revoke).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});
