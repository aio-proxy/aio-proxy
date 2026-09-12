import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareCodexCommandInstallation, readCodexCommandIdentity } from '../command-auth';
import { credentialPath, readCredential, writeCredential } from '../command-auth/credential-store';
import { resolveCodexLocation } from '../location';
import { configureCodexConfig, inspectCodexConfig } from '../managed-config';
import { authOperationPath } from '../setup/journal';
import { withCodexInstallation } from '../storage/installation-lock';
import { listCodexLifecycle, removeCodexLifecycle } from './lifecycle';

test('lists static authentication without checking the proxy and removes it idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  try {
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://127.0.0.1:9317/v1',
      auth: { mode: 'keep-chatgpt', token: 'aio-proxy-local' },
    });
    await expect(listCodexLifecycle({ location, check: false })).resolves.toMatchObject({
      authMode: 'keep-chatgpt',
      connection: 'not_checked',
    });
    await expect(
      listCodexLifecycle({
        location,
        check: true,
        checkStatic: async (baseUrl) => {
          expect(baseUrl).toBe('http://127.0.0.1:9317/v1');
          return 'ok';
        },
      }),
    ).resolves.toMatchObject({
      authMode: 'keep-chatgpt',
      connection: 'ok',
    });
    await expect(removeCodexLifecycle({ location })).resolves.toMatchObject({
      status: 'removed',
      keysRetained: true,
    });
    await expect(removeCodexLifecycle({ location })).resolves.toMatchObject({
      status: 'absent',
      keysRetained: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list --check does not send a keep-chatgpt key to a drifted endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  try {
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://127.0.0.1:9317/v1',
      auth: { mode: 'keep-chatgpt', token: 'aio-proxy-local' },
    });
    const configured = await readFile(location.configPath, 'utf8');
    await Bun.write(location.configPath, configured.replace('http://127.0.0.1:9317/v1', 'http://127.0.0.1:9999/v1'));
    const probed: { readonly baseUrl?: string; readonly token?: string }[] = [];
    await expect(
      listCodexLifecycle({
        location,
        check: true,
        checkStatic: async (baseUrl, token) => {
          probed.push({ baseUrl, token });
          return 'ok';
        },
      }),
    ).resolves.toMatchObject({
      status: 'modified',
      authMode: 'keep-chatgpt',
      connection: 'not_checked',
    });
    expect(probed).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list --check probes the stored keep-chatgpt token instead of public health', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  const previousFetch = globalThis.fetch;
  try {
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://127.0.0.1:9317/v1',
      auth: { mode: 'keep-chatgpt', token: 'stale-key' },
    });
    const seen: { path: string; authorization?: string }[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      seen.push({ path: url.pathname, authorization: headers.get('authorization') ?? undefined });
      if (url.pathname === '/health') return Response.json({ status: 'ok' });
      if (url.pathname === '/v1/models') return new Response('unauthorized', { status: 401 });
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;
    await expect(
      listCodexLifecycle({
        location,
        check: true,
        checkStatic: async (baseUrl, token) => {
          if (baseUrl === undefined || token === undefined) return 'offline';
          const endpoint = baseUrl.replace(/\/v1\/?$/u, '');
          const response = await fetch(`${endpoint}/v1/models`, {
            headers: { authorization: `Bearer ${token}` },
            redirect: 'error',
            signal: AbortSignal.timeout(3_000),
          });
          return response.status === 401 ? 'unauthorized' : 'ok';
        },
      }),
    ).resolves.toMatchObject({ connection: 'unauthorized' });
    expect(seen).toEqual([{ path: '/v1/models', authorization: 'Bearer stale-key' }]);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks command removal after revoke failure and keeps retry state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'aio-proxy',
          baseUrl: `${endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
      await writeCredential(location, {
        format: 1,
        installationId,
        endpoint,
        revision: 1,
        accessToken: `aio_agent_at_v1_${'a'.repeat(43)}`,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
      await import('../command-auth').then(({ activateCodexCommandInstallation }) =>
        activateCodexCommandInstallation(location, installationId, lease),
      );
    });
    await expect(
      removeCodexLifecycle({
        location,
        revoke: async () => {
          throw new Error('offline');
        },
      }),
    ).resolves.toMatchObject({ status: 'blocked', authorization: 'pending' });
    expect((await readCodexCommandIdentity(location))?.status).toBe('retiring');
    expect(JSON.parse(await readFile(authOperationPath(location), 'utf8'))).toMatchObject({
      phase: 'retiring',
      installationId,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lists a pending command installation before its config is committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  try {
    const installation = await withCodexInstallation(location, AbortSignal.timeout(10_000), (lease) =>
      prepareCodexCommandInstallation(
        { location, providerId: 'custom', endpoint: 'http://127.0.0.1:9317', adapterVersion: '0.21.0' },
        lease,
      ),
    );
    await expect(listCodexLifecycle({ location, check: false })).resolves.toMatchObject({
      providerId: 'custom',
      authMode: 'command',
      installationId: installation.marker.installationId,
      lifecycle: 'pending',
      credentialStatus: 'missing',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('revokes an orphan credential when the identity file is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'aio-proxy',
          baseUrl: `${endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
      await writeCredential(location, {
        format: 1,
        installationId,
        endpoint,
        revision: 1,
        accessToken: `aio_agent_at_v1_${'a'.repeat(43)}`,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
    });
    await rm(join(location.managedRoot, 'codex-command.json'));
    const revoked: { endpoint: string; installationId: string }[] = [];
    const result = await removeCodexLifecycle({
      location,
      revoke: async (boundEndpoint, boundInstallationId) => {
        revoked.push({ endpoint: boundEndpoint, installationId: boundInstallationId });
        return 'revoked';
      },
    });
    expect(result).toMatchObject({ status: 'removed', authorization: 'revoked' });
    expect(revoked).toEqual([{ endpoint, installationId }]);
    await expect(readCredential(location)).resolves.toBeUndefined();
    await expect(Bun.file(credentialPath(location)).exists()).resolves.toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks orphan-credential removal when remote revoke fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'aio-proxy',
          baseUrl: `${endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
      await writeCredential(location, {
        format: 1,
        installationId,
        endpoint,
        revision: 1,
        accessToken: `aio_agent_at_v1_${'a'.repeat(43)}`,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
    });
    await rm(join(location.managedRoot, 'codex-command.json'));
    await expect(
      removeCodexLifecycle({
        location,
        revoke: async () => {
          throw new Error('offline');
        },
      }),
    ).resolves.toMatchObject({ status: 'blocked', authorization: 'pending' });
    await expect(readCredential(location)).resolves.toMatchObject({ installationId });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks removal when command identity is unreadable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  try {
    await Bun.write(join(location.managedRoot, 'codex-command.json'), '{not-json');
    await expect(removeCodexLifecycle({ location })).resolves.toMatchObject({ status: 'blocked' });
    expect(await Bun.file(join(location.managedRoot, 'codex-command.json')).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('revokes from the marker applied endpoint when the live base_url drifted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'aio-proxy',
          baseUrl: `${endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
    });
    const configured = await readFile(location.configPath, 'utf8');
    await Bun.write(location.configPath, configured.replace(`${endpoint}/v1`, 'http://127.0.0.1:9999/v1'));
    await rm(join(location.managedRoot, 'codex-command.json'));
    const revoked: { endpoint: string; installationId: string }[] = [];
    await expect(
      removeCodexLifecycle({
        location,
        revoke: async (boundEndpoint, boundInstallationId) => {
          revoked.push({ endpoint: boundEndpoint, installationId: boundInstallationId });
          return 'revoked';
        },
      }),
    ).resolves.toMatchObject({ authorization: 'revoked' });
    expect(revoked).toEqual([{ endpoint, installationId }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('revokes from the managed marker when command auth files are missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'aio-proxy',
          baseUrl: `${endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
    });
    await rm(join(location.managedRoot, 'codex-command.json'));
    const revoked: { endpoint: string; installationId: string }[] = [];
    await expect(
      removeCodexLifecycle({
        location,
        revoke: async (boundEndpoint, boundInstallationId) => {
          revoked.push({ endpoint: boundEndpoint, installationId: boundInstallationId });
          return 'revoked';
        },
      }),
    ).resolves.toMatchObject({ status: 'removed', authorization: 'revoked' });
    expect(revoked).toEqual([{ endpoint, installationId }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks command removal when the managed config is conflicted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'aio-proxy',
          baseUrl: `${endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
      await writeCredential(location, {
        format: 1,
        installationId,
        endpoint,
        revision: 1,
        accessToken: `aio_agent_at_v1_${'a'.repeat(43)}`,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
    });
    await Bun.write(location.markerPath, '{not-json');
    const revoked: { endpoint: string; installationId: string }[] = [];
    await expect(
      removeCodexLifecycle({
        location,
        revoke: async (boundEndpoint, boundInstallationId) => {
          revoked.push({ endpoint: boundEndpoint, installationId: boundInstallationId });
          return 'revoked';
        },
      }),
    ).resolves.toMatchObject({ status: 'blocked', authorization: 'pending' });
    expect(revoked).toEqual([]);
    await expect(readCredential(location)).resolves.toMatchObject({ installationId });
    await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({
      marker: { installationId },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks removal when config recovery is invalid before revoking credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-lifecycle-'));
  const location = resolveCodexLocation(root, { HOME: root });
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'aio-proxy',
          baseUrl: `${endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
      await writeCredential(location, {
        format: 1,
        installationId,
        endpoint,
        revision: 1,
        accessToken: `aio_agent_at_v1_${'a'.repeat(43)}`,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
    });
    await writeFile(join(location.managedRoot, 'config-operation.json'), '{not-json');
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ status: 'managed', authMode: 'command' });
    const revoked: { endpoint: string; installationId: string }[] = [];
    await expect(
      removeCodexLifecycle({
        location,
        revoke: async (boundEndpoint, boundInstallationId) => {
          revoked.push({ endpoint: boundEndpoint, installationId: boundInstallationId });
          return 'revoked';
        },
      }),
    ).resolves.toMatchObject({ status: 'blocked' });
    expect(revoked).toEqual([]);
    await expect(readCredential(location)).resolves.toMatchObject({ installationId });
    await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({
      marker: { installationId },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
