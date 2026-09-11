import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentAdminSnapshot,
  AgentInstallationSummary,
  AgentPluginTarget,
  AgentRevokeStatus,
  AgentTarget,
} from '@aio-proxy/types';

import { agentConfigure, agentRemove, agentRevoke, type AgentCommandDeps } from './agent';
import { configureGrok, inspectGrok, type GrokInspection } from './grok';
import { configureGrokForTest } from './grok/configure';
import { grokFixture } from './grok/test-fixture';
import type { AgentHost, AgentLocation, AgentPluginLocation } from './hosts';
import { agentList } from './list';

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
  if (target === 'grok') return { target, hostRoot: '/tmp/grok', managedDir: '/tmp/grok/aio-proxy' };
  const hostRoot = `/tmp/${target}/${target === 'opencode' ? 'plugins' : 'extensions'}`;
  return {
    target,
    hostRoot,
    managedDir: `${hostRoot}/aio-proxy`,
    ...(target === 'opencode' ? { adjacentEntry: `${hostRoot}/aio-proxy.js` } : {}),
  };
};

const hashFiles = (root: string): string => {
  const hasher = createHash('sha256');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else hasher.update(path).update(readFileSync(path));
    }
  };
  walk(root);
  return hasher.digest('hex');
};

function commandFixture(
  options: {
    readonly server?: 'online' | 'offline';
    readonly serverHost?: string;
    readonly resolvedEndpoint?: string;
    readonly markerEndpoint?: string;
    readonly target?: AgentPluginTarget;
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
    readonly grokInspection?: GrokInspection;
    readonly grokRemoveSkipped?: readonly string[];
    readonly grokRemoveRetained?: readonly string[];
  } = {},
) {
  const missing = new Set(options.missingTargets ?? []);
  const pathFailures = new Set(options.pathFailureTargets ?? []);
  const localIds = options.localInstallationIds ?? (options.target === undefined ? [] : [INSTALLATION]);
  const localByTarget = new Map<AgentPluginTarget, string>();
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
  const resolveEndpoint = mock(async () => {
    if (options.serverHost !== undefined && options.serverHost !== '127.0.0.1')
      throw new Error('Agent integrations require loopback');
    return options.resolvedEndpoint ?? 'http://127.0.0.1:9317';
  });
  const readSnapshot = mock(async () => {
    if (options.server === 'offline') throw new TypeError('offline');
    return {
      installations: [...(options.serverInstallations ?? [])],
      deviceAuthorization: options.deviceAuthorization ?? 'available',
      catalogSchemaVersions: [...(options.catalogSchemaVersions ?? [1])],
    };
  });
  const grokMarker = {
    format: 1 as const,
    managedBy: 'aio-proxy' as const,
    agent: 'grok' as const,
    installationId: INSTALLATION,
    adapterVersion: '1.2.3',
    endpoint: options.markerEndpoint ?? 'http://127.0.0.1:9317',
  };
  const grokConfigure = mock(async () => {
    events.push('grok-configure');
    return { status: 'installed' as const, marker: grokMarker };
  });
  const grokInspect = mock(async (): Promise<GrokInspection> => {
    events.push('grok-inspect');
    return (
      options.grokInspection ?? {
        integrationKind: 'auth-command',
        integration: 'absent',
        configuration: 'missing',
        fields: [],
      }
    );
  });
  const grokRemove = mock(async () => {
    events.push('grok-remove');
    return {
      installationId: INSTALLATION,
      revokeStatus: options.revokeStatus ?? 'revoked',
      skippedFields: options.grokRemoveSkipped ?? [],
      retainedFiles: options.grokRemoveRetained ?? [],
    };
  });
  const resolveExecutable = mock(async () => '/opt/bin/aio-proxy');
  const grokRevoke = mock(async () => {
    events.push('grok-deps-revoke');
    return 'revoked' as const;
  });
  const deps: AgentCommandDeps = {
    detectHost: async (target) => ({
      target,
      detected: !missing.has(target),
      ...(missing.has(target)
        ? {}
        : {
            executable: `/usr/local/bin/${target}`,
            version: options.hostVersion ?? (target === 'grok' ? '1.0.24' : '99.0.0'),
          }),
      minimumVersion: target === 'grok' ? '1.0.24' : { opencode: '1.17.10', pi: '0.84.2', omp: '17.3.7' }[target],
      support: missing.has(target) ? 'unknown' : (options.hostSupport ?? 'supported'),
    }),
    resolveLocation: async (target) => {
      if (pathFailures.has(target)) throw new Error(`${target} path unavailable`);
      return commandLocation(target);
    },
    inspect: async (location: AgentPluginLocation) => {
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
          endpoint: options.markerEndpoint ?? 'http://127.0.0.1:9317',
        },
      };
    },
    resolveEndpoint,
    install,
    remove,
    readSnapshot,
    revoke,
    readAssets: async () => new Map([['index.js', new TextEncoder().encode('adapter')]]),
    adapterVersion: '1.2.3',
    randomUUID: () => INSTALLATION,
    now: () => Date.parse('2026-08-18T00:05:00.000Z'),
    codex: {
      configure: async () => {
        throw new Error('codex stub not configured');
      },
      list: async () => ({
        target: 'codex',
        integration: 'static-config',
        configPath: '/tmp/codex/config.toml',
        activeProviderId: 'openai',
        status: 'absent',
        connection: 'not_checked',
        changedPaths: [],
      }),
      remove: async () => ({
        target: 'codex',
        integration: 'static-config',
        configPath: '/tmp/codex/config.toml',
        keysRetained: true,
        status: 'absent',
        preservedPaths: [],
      }),
    },
    grok: {
      configure: grokConfigure,
      inspect: grokInspect,
      remove: grokRemove,
      resolveExecutable,
      deps: {
        now: () => Date.parse('2026-08-18T00:05:00.000Z'),
        randomUUID: () => INSTALLATION,
        policy: async () => ({ env: {}, sources: [] }),
        revoke: grokRevoke,
      },
    },
  };
  return {
    deps,
    events,
    install,
    remove,
    revoke,
    resolveEndpoint,
    readSnapshot,
    grokConfigure,
    grokInspect,
    grokRemove,
    resolveExecutable,
  };
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

test('remove revokes at the marker endpoint when the resolved endpoint has changed', async () => {
  const f = commandFixture({
    target: 'opencode',
    resolvedEndpoint: 'http://127.0.0.1:9417',
    markerEndpoint: 'http://127.0.0.1:9317',
  });
  await agentRemove('opencode', f.deps);
  expect(f.resolveEndpoint).not.toHaveBeenCalled();
  expect(f.revoke).toHaveBeenCalledTimes(1);
  expect(f.revoke).toHaveBeenCalledWith('http://127.0.0.1:9317', INSTALLATION);
  expect(f.events).toEqual(['revoke', 'remove']);
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
  expect(f.readSnapshot).toHaveBeenCalledTimes(1);
});

test('preserves Codex authorization from its stored endpoint when the current endpoint snapshot differs', async () => {
  const f = commandFixture({ serverInstallations: [] });
  const deps: AgentCommandDeps = {
    ...f.deps,
    codex: {
      ...f.deps.codex,
      list: async () => ({
        target: 'codex',
        integration: 'static-config',
        configPath: '/tmp/codex/config.toml',
        activeProviderId: 'aio-proxy',
        status: 'managed',
        connection: 'ok',
        authorization: 'active',
        installationId: INSTALLATION,
        changedPaths: [],
      }),
    },
  };
  const result = await agentList({ check: true }, deps);
  expect(result.codex).toMatchObject({ installationId: INSTALLATION, authorization: 'active' });
});

test('list --check returns the complete per-target and server capability contract', async () => {
  const f = commandFixture({
    localInstallationIds: [INSTALLATION],
    serverInstallations: [installation(INSTALLATION)],
    deviceAuthorization: 'password_required',
    catalogSchemaVersions: [1],
  });
  const result = await agentList({ check: true }, f.deps);
  expect(result.targets.map(({ target }) => target)).toEqual(['opencode', 'pi', 'omp', 'grok']);
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
  expect(f.readSnapshot).toHaveBeenCalledTimes(1);
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
  expect(f.readSnapshot).toHaveBeenCalledTimes(1);
});

test('list --check leaves target checks not_checked when the snapshot is unreachable', async () => {
  const f = commandFixture({
    localInstallationIds: [INSTALLATION],
    server: 'offline',
  });
  const result = await agentList({ check: true }, f.deps);
  expect(result).toMatchObject({ server: 'unreachable' });
  expect(result.deviceAuthorization).toBeUndefined();
  expect(result.catalogSchemaVersions).toBeUndefined();
  expect(result.targets).toContainEqual(
    expect.objectContaining({
      target: 'opencode',
      authorization: 'not_checked',
      schemaCompatibility: 'not_checked',
    }),
  );
  expect(f.readSnapshot).toHaveBeenCalledTimes(1);
});

test('list --check leaves target checks not_checked when endpoint resolution fails', async () => {
  const f = commandFixture({
    localInstallationIds: [INSTALLATION],
    serverHost: '192.0.2.10',
  });
  const result = await agentList({ check: true }, f.deps);
  expect(result).toMatchObject({ server: 'unreachable' });
  expect(result.deviceAuthorization).toBeUndefined();
  expect(result.catalogSchemaVersions).toBeUndefined();
  expect(result.targets).toContainEqual(
    expect.objectContaining({
      target: 'opencode',
      authorization: 'not_checked',
      schemaCompatibility: 'not_checked',
    }),
  );
  expect(f.readSnapshot).not.toHaveBeenCalled();
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
  expect(f.readSnapshot).not.toHaveBeenCalled();
});

test('list isolates a failed Codex inspection from other integrations', async () => {
  const f = commandFixture({ localInstallationIds: [INSTALLATION] });
  const result = await agentList(
    {},
    {
      ...f.deps,
      codex: {
        ...f.deps.codex,
        list: async () => {
          throw new Error('Refusing symbolic link: /tmp/codex/config.toml');
        },
      },
    },
  );
  expect(result.codex).toMatchObject({ status: 'conflict', connection: 'not_checked' });
  expect(result.targets.map(({ target }) => target)).toEqual(['opencode', 'pi', 'omp', 'grok']);
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

test('revoke rejects an invalid installation id before resolving the endpoint', async () => {
  const f = commandFixture();
  await expect(agentRevoke('not-a-uuid', f.deps)).rejects.toThrow();
  expect(f.resolveEndpoint).not.toHaveBeenCalled();
  expect(f.revoke).not.toHaveBeenCalled();
});

test('revoke invokes the client once with the resolved endpoint and installation id', async () => {
  const f = commandFixture();
  await expect(agentRevoke(INSTALLATION, f.deps)).resolves.toEqual({
    installationId: INSTALLATION,
    status: 'revoked',
  });
  expect(f.resolveEndpoint).toHaveBeenCalledTimes(1);
  expect(f.revoke).toHaveBeenCalledTimes(1);
  expect(f.revoke).toHaveBeenCalledWith('http://127.0.0.1:9317', INSTALLATION);
});

test('configure grok uses resolveEndpoint, resolveGrokExecutable, and grok.deps without plugin assets', async () => {
  const f = commandFixture();
  await expect(agentConfigure('grok', f.deps)).resolves.toMatchObject({
    target: 'grok',
    installed: true,
    status: 'installed',
    loginCommand: 'grok login',
    reloadRequired: true,
  });
  expect(f.install).not.toHaveBeenCalled();
  expect(f.grokConfigure).toHaveBeenCalledTimes(1);
  expect(f.resolveExecutable).toHaveBeenCalledTimes(1);
  expect(f.resolveEndpoint).toHaveBeenCalledTimes(1);
});

test('remove grok enters locked removeGrok and does not reuse lock-outside plugin revoke', async () => {
  const f = commandFixture({ grokRemoveSkipped: ['auth.auth_provider_label'], grokRemoveRetained: ['unknown.txt'] });
  await expect(agentRemove('grok', f.deps)).resolves.toMatchObject({
    target: 'grok',
    installationId: INSTALLATION,
    skippedFields: ['auth.auth_provider_label'],
    retainedFiles: ['unknown.txt'],
  });
  expect(f.events).toEqual(['grok-remove']);
  expect(f.revoke).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});

test('list walks all four targets and inspects Grok without a host binary', async () => {
  const f = commandFixture({
    missingTargets: ['grok'],
    grokInspection: {
      integrationKind: 'auth-command',
      integration: 'managed',
      configuration: 'current',
      fields: [],
      marker: {
        format: 1,
        managedBy: 'aio-proxy',
        agent: 'grok',
        installationId: INSTALLATION,
        adapterVersion: '1.2.3',
        endpoint: 'http://127.0.0.1:9317',
      },
    },
  });
  const result = await agentList({}, f.deps);
  expect(result.targets.map((row) => row.target)).toEqual(['opencode', 'pi', 'omp', 'grok']);
  expect(result.targets).toContainEqual(
    expect.objectContaining({
      target: 'grok',
      host: expect.objectContaining({ detected: false }),
      integrationKind: 'auth-command',
      integration: 'managed',
      catalog: 'host_managed',
      schemaCompatibility: 'not_applicable',
      marker: expect.objectContaining({ installationId: INSTALLATION }),
    }),
  );
  expect(f.grokInspect).toHaveBeenCalledTimes(1);
  expect(f.readSnapshot).not.toHaveBeenCalled();
});

test('offline Grok list is read-only and does not issue, refresh, or recover', async () => {
  const g = await grokFixture();
  try {
    await expect(
      configureGrokForTest(g.input, g.deps, {
        failpoint: (point) => {
          if (point === 'marker') throw new Error('crash after marker');
        },
      }),
    ).rejects.toThrow(/crash after marker/);
    const before = hashFiles(g.root);
    const f = commandFixture();
    const deps: AgentCommandDeps = {
      ...f.deps,
      resolveLocation: async (target) =>
        target === 'grok'
          ? { target, hostRoot: g.root, managedDir: join(g.root, 'aio-proxy') }
          : commandLocation(target),
      grok: { ...f.deps.grok, inspect: inspectGrok },
    };
    const result = await agentList({}, deps);
    expect(result.targets).toContainEqual(
      expect.objectContaining({
        target: 'grok',
        configuration: 'recovery_required',
        marker: expect.objectContaining({ installationId: g.deps.randomUUID() }),
      }),
    );
    expect(hashFiles(g.root)).toBe(before);
    expect(f.readSnapshot).not.toHaveBeenCalled();
    expect(f.revoke).not.toHaveBeenCalled();
  } finally {
    await g.cleanup();
  }
});

test('modified Grok stays configured for authorizations when the marker is valid', async () => {
  const grokInstallation: AgentInstallationSummary = {
    installationId: INSTALLATION,
    target: 'grok',
    adapterVersion: '1.2.3',
    createdAt: '2026-08-18T00:00:00.000Z',
    lastAuthorizedAt: '2026-08-18T00:00:01.000Z',
    authorization: 'active',
    accessExpiresAt: '2026-08-18T00:15:01.000Z',
  };
  const f = commandFixture({
    grokInspection: {
      integrationKind: 'auth-command',
      integration: 'managed',
      configuration: 'modified',
      fields: ['auth.auth_provider_label'],
      marker: {
        format: 1,
        managedBy: 'aio-proxy',
        agent: 'grok',
        installationId: INSTALLATION,
        adapterVersion: '1.2.3',
        endpoint: 'http://127.0.0.1:9317',
      },
    },
    serverInstallations: [grokInstallation],
  });
  const result = await agentList({ authorizations: true, check: true }, f.deps);
  expect(result.targets).toContainEqual(
    expect.objectContaining({
      target: 'grok',
      configuration: 'modified',
      authorization: 'active',
      catalog: 'host_managed',
      schemaCompatibility: 'not_applicable',
      marker: expect.objectContaining({ installationId: INSTALLATION }),
    }),
  );
  expect(result.authorizations).toEqual([
    expect.objectContaining({ installationId: INSTALLATION, local: 'configured' }),
  ]);
});

test('Grok list JSON does not include tokens from the credential file', async () => {
  const g = await grokFixture();
  try {
    const installed = await configureGrok(g.input, g.deps);
    await writeFile(
      join(g.root, 'aio-proxy', 'credential.json'),
      `${JSON.stringify({
        accessToken: 'aio_agent_at_v1_secret-token',
        refreshToken: 'aio_agent_rt_v1_secret-refresh',
      })}\n`,
      { mode: 0o600 },
    );
    const f = commandFixture();
    const deps: AgentCommandDeps = {
      ...f.deps,
      resolveLocation: async (target) =>
        target === 'grok'
          ? { target, hostRoot: g.root, managedDir: join(g.root, 'aio-proxy') }
          : commandLocation(target),
      grok: { ...f.deps.grok, inspect: inspectGrok },
    };
    const result = await agentList({ json: true }, deps);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain('aio_agent_at_v1_secret-token');
    expect(encoded).not.toContain('aio_agent_rt_v1_secret-refresh');
    expect(encoded).not.toContain('accessToken');
    expect(encoded).not.toContain('refreshToken');
    expect(result.targets).toContainEqual(
      expect.objectContaining({
        target: 'grok',
        marker: expect.objectContaining({ installationId: installed.marker.installationId }),
      }),
    );
  } finally {
    await g.cleanup();
  }
});
