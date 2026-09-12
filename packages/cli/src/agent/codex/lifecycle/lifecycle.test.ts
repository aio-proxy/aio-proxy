import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareCodexCommandInstallation, readCodexCommandIdentity } from '../command-auth';
import { credentialPath, readCredential, writeCredential } from '../command-auth/credential-store';
import { resolveCodexLocation } from '../location';
import { configureCodexConfig } from '../managed-config';
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

test('removes an orphan credential without attempting remote revocation', async () => {
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
    let revokeCalls = 0;
    const result = await removeCodexLifecycle({
      location,
      revoke: async () => {
        revokeCalls += 1;
        return 'revoked';
      },
    });
    expect(result).toMatchObject({ status: 'removed' });
    expect(result.authorization).toBe('missing');
    expect(revokeCalls).toBe(0);
    await expect(readCredential(location)).resolves.toBeUndefined();
    await expect(Bun.file(credentialPath(location)).exists()).resolves.toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
