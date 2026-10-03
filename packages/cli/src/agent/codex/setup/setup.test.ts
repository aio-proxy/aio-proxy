import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activateCodexCommandInstallation,
  prepareCodexCommandInstallation,
  readCodexCommandIdentity,
} from '../command-auth';
import * as commandAuth from '../command-auth';
import { credentialPath, readCredential, writeCredential } from '../command-auth/credential-store';
import type { CodexSetupContext } from '../contracts';
import { resolveCodexLocation } from '../location';
import * as managedConfig from '../managed-config';
import { configureCodexConfig, inspectCodexConfig } from '../managed-config';
import * as catalogStorage from '../managed-config/storage';
import { fetchCodexCatalog } from '../model-catalog';
import { withCodexInstallation } from '../storage/installation-lock';
import { authOperationPath, writeAuthOperation } from './journal';
import { commitCodexSetup, recoverCodexAuthOperation } from './setup';

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-setup-'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  return { root, location: resolveCodexLocation(root, { HOME: root }) };
};

test('recovery blocks a pending command operation when its endpoint changed', async () => {
  const { root, location } = await fixture();
  const originalEndpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    let fetchCalls = 0;
    globalThis.fetch = (async (input) => {
      fetchCalls += 1;
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === '/oauth/token')
        return Response.json({
          token_type: 'Bearer',
          access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
          refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`,
          expires_in: 900,
        });
      return Response.json({
        device_code: 'd'.repeat(43),
        user_code: 'ABCD-EFGH',
        verification_uri: `${originalEndpoint}/dashboard/agents/authorize`,
        verification_uri_complete: `${originalEndpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
        expires_in: 600,
        interval: 5,
      });
    }) as typeof fetch;
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint: originalEndpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
    });
    await writeAuthOperation(location, {
      configPath: location.configPath,
      kind: 'configure',
      phase: 'prepared',
      targetMode: 'command',
      installationId,
      providerId: 'aio-proxy',
    });
    let devicePrompts = 0;
    const context: CodexSetupContext = {
      location,
      endpoint: 'http://127.0.0.1:9318',
      adapterVersion: '0.21.0',
      fetchCatalog: async () => ({ models: [] }),
      signal: AbortSignal.timeout(10_000),
      onDevice: async () => {
        devicePrompts += 1;
        throw new Error('unexpected authorization');
      },
    };
    await expect(recoverCodexAuthOperation(context, 'complete')).resolves.toBe('blocked');
    expect(devicePrompts).toBe(0);
    expect(fetchCalls).toBe(0);
    const journal = await readFile(authOperationPath(location), 'utf8');
    expect(journal).not.toContain(originalEndpoint);
    expect(journal).not.toContain('aio_agent_');
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('completes a leftover remove journal during configure recovery', async () => {
  const { root, location } = await fixture();
  const installationId = crypto.randomUUID();
  try {
    await writeAuthOperation(location, {
      configPath: location.configPath,
      kind: 'remove',
      fromMode: 'command',
      phase: 'revoked',
      installationId,
      providerId: 'aio-proxy',
    });
    await expect(
      recoverCodexAuthOperation(
        {
          location,
          endpoint: 'http://127.0.0.1:9317',
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            throw new Error('unexpected authorization');
          },
          revoke: async () => {
            throw new Error('unexpected revoke');
          },
        },
        'complete',
      ),
    ).resolves.toBe('completed');
    await expect(Bun.file(authOperationPath(location)).exists()).resolves.toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports an unknown authentication journal state as blocked', async () => {
  const { root, location } = await fixture();
  try {
    await Bun.write(
      authOperationPath(location),
      `${JSON.stringify({
        format: 1,
        operationId: crypto.randomUUID(),
        configPath: location.configPath,
        kind: 'configure',
        phase: 'unknown',
        providerId: 'aio-proxy',
      })}\n`,
    );
    await expect(
      recoverCodexAuthOperation(
        {
          location,
          endpoint: 'http://127.0.0.1:9317',
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
        },
        'complete',
      ),
    ).resolves.toBe('blocked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery rejects a keep-chatgpt journal that carries an unrelated installation id', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const unrelatedId = crypto.randomUUID();
  try {
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: `${endpoint}/v1`,
      auth: { mode: 'keep-chatgpt', token: 'aio-proxy-local' },
    });
    await Bun.write(
      authOperationPath(location),
      `${JSON.stringify({
        format: 1,
        operationId: crypto.randomUUID(),
        configPath: location.configPath,
        kind: 'configure',
        targetMode: 'keep-chatgpt',
        phase: 'prepared',
        installationId: unrelatedId,
        providerId: 'aio-proxy',
      })}\n`,
    );
    const revoked: { endpoint: string; installationId: string }[] = [];
    await expect(
      recoverCodexAuthOperation(
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
          revoke: async (boundEndpoint, boundInstallationId) => {
            revoked.push({ endpoint: boundEndpoint, installationId: boundInstallationId });
            return 'revoked';
          },
        },
        'complete',
      ),
    ).resolves.toBe('blocked');
    expect(revoked).toEqual([]);
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({
      status: 'managed',
      authMode: 'keep-chatgpt',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers a command to keep-chatgpt transition after command auth was revoked', async () => {
  const { root, location } = await fixture();
  try {
    const installationId = crypto.randomUUID();
    await import('../managed-config').then(({ configureCodexConfig }) =>
      configureCodexConfig({
        location,
        providerId: 'custom',
        baseUrl: 'http://127.0.0.1:9317/v1',
        auth: { mode: 'command', installationId, command: 'aiop' },
      }),
    );
    await writeAuthOperation(location, {
      configPath: location.configPath,
      kind: 'switch',
      fromMode: 'command',
      targetMode: 'keep-chatgpt',
      phase: 'revoked',
      providerId: 'custom',
      installationId,
    });
    await expect(
      recoverCodexAuthOperation(
        {
          location,
          endpoint: 'http://127.0.0.1:9317',
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
        },
        'complete',
      ),
    ).resolves.toBe('completed');
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ status: 'absent' });
    await expect(readCodexCommandIdentity(location)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers a keep-chatgpt transition after identity deletion leaves an orphan credential', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'custom', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'custom',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId, command: 'aiop' },
          },
          lease,
        ),
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
    await writeAuthOperation(location, {
      configPath: location.configPath,
      kind: 'switch',
      fromMode: 'command',
      targetMode: 'keep-chatgpt',
      phase: 'revoked',
      providerId: 'custom',
      installationId,
    });
    await rm(join(location.managedRoot, 'codex-command.json'));
    const revoked: { endpoint: string; installationId: string }[] = [];
    await expect(
      recoverCodexAuthOperation(
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
          revoke: async (boundEndpoint, boundInstallationId) => {
            revoked.push({ endpoint: boundEndpoint, installationId: boundInstallationId });
            return 'revoked';
          },
        },
        'complete',
      ),
    ).resolves.toBe('completed');
    expect(revoked).toEqual([{ endpoint, installationId }]);
    await expect(readCredential(location)).resolves.toBeUndefined();
    await expect(Bun.file(credentialPath(location)).exists()).resolves.toBe(false);
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ status: 'absent' });
    await expect(readCodexCommandIdentity(location)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleans an orphan credential during a normal keep-chatgpt transition', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'custom', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'custom',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId, command: 'aiop' },
          },
          lease,
        ),
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
    await expect(
      commitCodexSetup(
        {
          providerId: 'custom',
          auth: {
            mode: 'keep-chatgpt',
            selection: { kind: 'none' },
            keys: {
              choices: [],
              resolve: async () => ({ token: 'aio-proxy-local', kind: 'placeholder', verified: false }),
            },
          },
        },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
          revoke: async (boundEndpoint, boundInstallationId) => {
            revoked.push({ endpoint: boundEndpoint, installationId: boundInstallationId });
            return 'revoked';
          },
        },
      ),
    ).resolves.toMatchObject({ authMode: 'keep-chatgpt' });
    expect(revoked).toEqual([{ endpoint, installationId }]);
    await expect(readCredential(location)).resolves.toBeUndefined();
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ authMode: 'keep-chatgpt' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('revokes a marker-only command installation when switching to keep-chatgpt', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  try {
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'custom', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'custom',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId, command: 'aiop' },
          },
          lease,
        ),
      );
    });
    await rm(join(location.managedRoot, 'codex-command.json'));
    await expect(Bun.file(join(location.managedRoot, 'codex-credential.json')).exists()).resolves.toBe(false);
    const revoked: { endpoint: string; installationId: string }[] = [];
    await expect(
      commitCodexSetup(
        {
          providerId: 'custom',
          auth: {
            mode: 'keep-chatgpt',
            selection: { kind: 'none' },
            keys: {
              choices: [],
              resolve: async () => ({ token: 'aio-proxy-local', kind: 'placeholder', verified: false }),
            },
          },
        },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
          revoke: async (boundEndpoint, boundInstallationId) => {
            revoked.push({ endpoint: boundEndpoint, installationId: boundInstallationId });
            return 'revoked';
          },
        },
      ),
    ).resolves.toMatchObject({ authMode: 'keep-chatgpt' });
    expect(revoked).toEqual([{ endpoint, installationId }]);
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ authMode: 'keep-chatgpt' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reuses an orphan command credential instead of preparing a new installation', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/models') return Response.json({ object: 'list', data: [] });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'custom', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'custom',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId, command: 'aiop' },
          },
          lease,
        ),
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
    let devicePrompts = 0;
    await expect(
      commitCodexSetup(
        { providerId: 'custom', auth: { mode: 'command', command: 'aiop' } },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            devicePrompts += 1;
          },
        },
      ),
    ).resolves.toMatchObject({ authMode: 'command', installationId });
    expect(devicePrompts).toBe(0);
    await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({
      status: 'active',
      marker: { installationId },
    });
    await expect(readCredential(location)).resolves.toMatchObject({ installationId });
    await expect(Bun.file(authOperationPath(location)).exists()).resolves.toBe(false);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('restores a marker-only command installation instead of preparing a new identity', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/oauth/device/code')
        return Response.json({
          device_code: 'd'.repeat(43),
          user_code: 'ABCD-EFGH',
          verification_uri: `${endpoint}/dashboard/agents/authorize`,
          verification_uri_complete: `${endpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      if (path === '/oauth/token')
        return Response.json({
          token_type: 'Bearer',
          access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
          refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`,
          expires_in: 900,
        });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'custom', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'custom',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId, command: 'aiop' },
          },
          lease,
        ),
      );
    });
    await rm(join(location.managedRoot, 'codex-command.json'));
    await expect(Bun.file(join(location.managedRoot, 'codex-credential.json')).exists()).resolves.toBe(false);
    let devicePrompts = 0;
    await expect(
      commitCodexSetup(
        { providerId: 'custom', auth: { mode: 'command', command: 'aiop' } },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            devicePrompts += 1;
          },
        },
      ),
    ).resolves.toMatchObject({ authMode: 'command', installationId });
    expect(devicePrompts).toBe(1);
    await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({
      status: 'active',
      marker: { installationId },
    });
    await expect(readCredential(location)).resolves.toMatchObject({ installationId });
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('rebinds a renamed command identity before recovering authorization', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/models') return Response.json({ object: 'list', data: [] });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const { configureCodexConfig } = await import('../managed-config');
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'old-id', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'old-id',
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
      await activateCodexCommandInstallation(location, installationId, lease);
      await configureCodexConfig(
        {
          location,
          providerId: 'new-id',
          baseUrl: `${endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
    });
    await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({ providerId: 'old-id' });
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ providerId: 'new-id', authMode: 'command' });
    await writeAuthOperation(location, {
      configPath: location.configPath,
      kind: 'switch',
      fromMode: 'command',
      targetMode: 'command',
      phase: 'config-written',
      installationId,
      providerId: 'new-id',
    });
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true, mode: 0o755 });
    await writeFile(join(bin, 'aiop'), '#!/bin/sh\necho "aiop 0.21.0"\n', { mode: 0o755 });
    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${bin}:${previousPath ?? ''}`;
    try {
      await expect(
        recoverCodexAuthOperation(
          {
            location,
            endpoint,
            adapterVersion: '0.21.0',
            fetchCatalog: async () => ({ models: [] }),
            signal: AbortSignal.timeout(10_000),
            onDevice: async () => {
              throw new Error('unexpected device authorization');
            },
          },
          'complete',
        ),
      ).resolves.toBe('completed');
      await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({
        providerId: 'new-id',
        status: 'active',
      });
      await expect(Bun.file(authOperationPath(location)).exists()).resolves.toBe(false);
    } finally {
      process.env['PATH'] = previousPath;
    }
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('rebinds a command installation when the managed Provider ID changes', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/models') return Response.json({ object: 'list', data: [] });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'old-id', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'old-id',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId, command: 'aiop' },
          },
          lease,
        ),
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
      await activateCodexCommandInstallation(location, installationId, lease);
    });
    await commitCodexSetup(
      { providerId: 'new-id', auth: { mode: 'command', command: 'aiop' } },
      {
        location,
        endpoint,
        adapterVersion: '0.21.0',
        fetchCatalog: async () => ({ models: [] }),
        signal: AbortSignal.timeout(10_000),
        onDevice: async () => undefined,
      },
    );
    await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({ providerId: 'new-id' });
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ providerId: 'new-id', authMode: 'command' });
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('refreshes a locally unexpired credential after the probe returns unauthorized', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  const rejectedAccess = `aio_agent_at_v1_${'a'.repeat(43)}`;
  const rotatedAccess = `aio_agent_at_v1_${'c'.repeat(43)}`;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/models') return new Response('unauthorized', { status: 401 });
      if (path === '/oauth/device/code') throw new Error('unexpected device authorization');
      return Response.json({
        token_type: 'Bearer',
        access_token: rotatedAccess,
        refresh_token: `aio_agent_rt_v1_${'d'.repeat(43)}`,
        expires_in: 900,
      });
    }) as typeof fetch;
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'aio-proxy',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId: installation.marker.installationId, command: 'aiop' },
          },
          lease,
        ),
      );
      await writeCredential(location, {
        format: 1,
        installationId: installation.marker.installationId,
        endpoint,
        revision: 1,
        accessToken: rejectedAccess,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
      await activateCodexCommandInstallation(location, installation.marker.installationId, lease);
    });
    let devicePrompts = 0;
    await expect(
      commitCodexSetup(
        { providerId: 'aio-proxy', auth: { mode: 'command', command: 'aiop' } },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            devicePrompts += 1;
          },
        },
      ),
    ).resolves.toMatchObject({ authMode: 'command' });
    expect(devicePrompts).toBe(0);
    await expect(readCredential(location)).resolves.toMatchObject({
      status: 'ready',
      accessToken: rotatedAccess,
    });
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers a refreshing credential before activating the command installation', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  const staleAccess = `aio_agent_at_v1_${'a'.repeat(43)}`;
  const rotatedAccess = `aio_agent_at_v1_${'c'.repeat(43)}`;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/models') return Response.json({ object: 'list', data: [] });
      if (path === '/oauth/device/code') throw new Error('unexpected device authorization');
      return Response.json({
        token_type: 'Bearer',
        access_token: rotatedAccess,
        refresh_token: `aio_agent_rt_v1_${'d'.repeat(43)}`,
        expires_in: 900,
      });
    }) as typeof fetch;
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'aio-proxy',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId: installation.marker.installationId, command: 'aiop' },
          },
          lease,
        ),
      );
      await writeCredential(location, {
        format: 1,
        installationId: installation.marker.installationId,
        endpoint,
        revision: 1,
        accessToken: staleAccess,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
      await activateCodexCommandInstallation(location, installation.marker.installationId, lease);
      await writeCredential(location, {
        format: 1,
        installationId: installation.marker.installationId,
        endpoint,
        revision: 1,
        accessToken: staleAccess,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'refreshing',
        refreshStartedAt: Date.now(),
      });
    });
    let devicePrompts = 0;
    await expect(
      commitCodexSetup(
        { providerId: 'aio-proxy', auth: { mode: 'command', command: 'aiop' } },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            devicePrompts += 1;
          },
        },
      ),
    ).resolves.toMatchObject({ authMode: 'command' });
    expect(devicePrompts).toBe(0);
    await expect(readCredential(location)).resolves.toMatchObject({
      status: 'ready',
      accessToken: rotatedAccess,
    });
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('reauthorizes an active command identity during operation recovery', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/oauth/device/code')
        return Response.json({
          device_code: 'e'.repeat(43),
          user_code: 'ABCD-EFGH',
          verification_uri: `${endpoint}/dashboard/agents/authorize`,
          verification_uri_complete: `${endpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      return Response.json({
        token_type: 'Bearer',
        access_token: `aio_agent_at_v1_${'c'.repeat(43)}`,
        refresh_token: `aio_agent_rt_v1_${'d'.repeat(43)}`,
        expires_in: 900,
      });
    }) as typeof fetch;
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'aio-proxy',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId, command: 'aiop' },
          },
          lease,
        ),
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
      await activateCodexCommandInstallation(location, installationId, lease);
      await writeCredential(location, {
        format: 1,
        installationId,
        endpoint,
        revision: 1,
        accessToken: `aio_agent_at_v1_${'a'.repeat(43)}`,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'reauthorize',
      });
    });
    await writeAuthOperation(location, {
      configPath: location.configPath,
      kind: 'configure',
      phase: 'prepared',
      targetMode: 'command',
      installationId,
      providerId: 'aio-proxy',
    });
    let devicePrompts = 0;
    await expect(
      recoverCodexAuthOperation(
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            devicePrompts += 1;
            throw new Error('cancelled');
          },
        },
        'complete',
      ),
    ).resolves.toBe('blocked');
    expect(devicePrompts).toBe(1);
    await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({ status: 'active' });
    await expect(readCredential(location)).resolves.toMatchObject({ status: 'reauthorize' });
    await expect(Bun.file(authOperationPath(location)).exists()).resolves.toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a drifted keep-chatgpt config before command authorization', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  try {
    await import('../managed-config').then(({ configureCodexConfig }) =>
      configureCodexConfig({
        location,
        providerId: 'keep-id',
        baseUrl: `${endpoint}/v1`,
        auth: { mode: 'keep-chatgpt', token: 'aio-proxy-local' },
      }),
    );
    const configured = await readFile(location.configPath, 'utf8');
    await writeFile(location.configPath, configured.replace('AIO Proxy', 'User Edited'));
    let devicePrompts = 0;
    await expect(
      commitCodexSetup(
        { providerId: 'command-id', auth: { mode: 'command', command: 'aiop' } },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            devicePrompts += 1;
          },
        },
      ),
    ).rejects.toThrow();
    expect(devicePrompts).toBe(0);
    await expect(readCodexCommandIdentity(location)).resolves.toBeUndefined();
    await expect(Bun.file(authOperationPath(location)).exists()).resolves.toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('switches keep-chatgpt to command by authorizing before rewriting config', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/oauth/device/code')
        return Response.json({
          device_code: 'e'.repeat(43),
          user_code: 'ABCD-EFGH',
          verification_uri: `${endpoint}/dashboard/agents/authorize`,
          verification_uri_complete: `${endpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      if (path === '/oauth/token')
        return Response.json({
          token_type: 'Bearer',
          access_token: `aio_agent_at_v1_${'c'.repeat(43)}`,
          refresh_token: `aio_agent_rt_v1_${'d'.repeat(43)}`,
          expires_in: 900,
        });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    await import('../managed-config').then(({ configureCodexConfig }) =>
      configureCodexConfig({
        location,
        providerId: 'keep-id',
        baseUrl: `${endpoint}/v1`,
        auth: { mode: 'keep-chatgpt', token: 'aio-proxy-local' },
      }),
    );
    let devicePrompts = 0;
    await expect(
      commitCodexSetup(
        { providerId: 'command-id', auth: { mode: 'command', command: 'aiop' } },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            devicePrompts += 1;
          },
        },
      ),
    ).resolves.toMatchObject({ authMode: 'command', connection: 'ok' });
    expect(devicePrompts).toBe(1);
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({
      providerId: 'command-id',
      authMode: 'command',
    });
    await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({
      providerId: 'command-id',
      status: 'active',
    });
    await expect(Bun.file(authOperationPath(location)).exists()).resolves.toBe(false);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers a keep-chatgpt to command switch after authorization was interrupted', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/oauth/device/code')
        return Response.json({
          device_code: 'e'.repeat(43),
          user_code: 'ABCD-EFGH',
          verification_uri: `${endpoint}/dashboard/agents/authorize`,
          verification_uri_complete: `${endpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      if (path === '/oauth/token')
        return Response.json({
          token_type: 'Bearer',
          access_token: `aio_agent_at_v1_${'c'.repeat(43)}`,
          refresh_token: `aio_agent_rt_v1_${'d'.repeat(43)}`,
          expires_in: 900,
        });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    await import('../managed-config').then(({ configureCodexConfig }) =>
      configureCodexConfig({
        location,
        providerId: 'keep-id',
        baseUrl: `${endpoint}/v1`,
        auth: { mode: 'keep-chatgpt', token: 'aio-proxy-local' },
      }),
    );
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'command-id', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
    });
    await writeAuthOperation(location, {
      configPath: location.configPath,
      kind: 'switch',
      fromMode: 'keep-chatgpt',
      targetMode: 'command',
      phase: 'prepared',
      installationId,
      providerId: 'command-id',
    });
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true, mode: 0o755 });
    await writeFile(join(bin, 'aiop'), '#!/bin/sh\necho "aiop 0.21.0"\n', { mode: 0o755 });
    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${bin}:${previousPath ?? ''}`;
    let devicePrompts = 0;
    try {
      await expect(
        recoverCodexAuthOperation(
          {
            location,
            endpoint,
            adapterVersion: '0.21.0',
            fetchCatalog: async () => ({ models: [] }),
            signal: AbortSignal.timeout(10_000),
            onDevice: async () => {
              devicePrompts += 1;
            },
          },
          'complete',
        ),
      ).resolves.toBe('completed');
      expect(devicePrompts).toBe(1);
      await expect(inspectCodexConfig(location)).resolves.toMatchObject({
        providerId: 'command-id',
        authMode: 'command',
      });
      await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({ status: 'active' });
    } finally {
      process.env['PATH'] = previousPath;
    }
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a failed command probe instead of reporting a verified connection', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/models') return Response.json([]);
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'aio-proxy',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId: installation.marker.installationId, command: 'aiop' },
          },
          lease,
        ),
      );
      await writeCredential(location, {
        format: 1,
        installationId: installation.marker.installationId,
        endpoint,
        revision: 1,
        accessToken: `aio_agent_at_v1_${'a'.repeat(43)}`,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
      await activateCodexCommandInstallation(location, installation.marker.installationId, lease);
    });
    let devicePrompts = 0;
    await expect(
      commitCodexSetup(
        { providerId: 'aio-proxy', auth: { mode: 'command', command: 'aiop' } },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            devicePrompts += 1;
          },
        },
      ),
    ).resolves.toMatchObject({ authMode: 'command', connection: 'invalid_response' });
    expect(devicePrompts).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('bounds the active-credential probe separately from the device-login signal', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path !== '/v1/models') throw new Error(`unexpected ${path}`);
      const signal = input instanceof Request ? input.signal : init?.signal;
      await new Promise<never>((_, reject) => {
        const abort = () => {
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
      throw new Error('unreachable');
    }) as typeof fetch;
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location, providerId: 'aio-proxy', endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      await import('../managed-config').then(({ configureCodexConfig }) =>
        configureCodexConfig(
          {
            location,
            providerId: 'aio-proxy',
            baseUrl: `${endpoint}/v1`,
            auth: { mode: 'command', installationId: installation.marker.installationId, command: 'aiop' },
          },
          lease,
        ),
      );
      await writeCredential(location, {
        format: 1,
        installationId: installation.marker.installationId,
        endpoint,
        revision: 1,
        accessToken: `aio_agent_at_v1_${'a'.repeat(43)}`,
        refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
      await activateCodexCommandInstallation(location, installation.marker.installationId, lease);
    });
    const startedAt = Date.now();
    await expect(
      commitCodexSetup(
        { providerId: 'aio-proxy', auth: { mode: 'command', command: 'aiop' } },
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          fetchCatalog: async () => ({ models: [] }),
          signal: AbortSignal.timeout(600_000),
          onDevice: async () => {
            throw new Error('unexpected authorization');
          },
        },
      ),
    ).resolves.toMatchObject({ connection: 'offline' });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

const fullCatalog = {
  models: [
    {
      slug: 'full-model',
      display_name: 'Full model',
      priority: 1,
      supported_in_api: true,
      visibility: 'list',
      base_instructions: '',
      model_messages: {
        instructions_template: 'FULL INSTRUCTIONS',
        future: { additional: ['UNTRIMMED MESSAGE'] },
      },
    },
  ],
};
const keepSelection = {
  providerId: 'aio-proxy',
  auth: {
    mode: 'keep-chatgpt' as const,
    selection: { kind: 'none' as const },
    keys: {
      choices: [],
      resolve: async () => ({ token: 'selected-proxy-token', kind: 'existing' as const, verified: true }),
    },
  },
};
const catalogContext = (location: CodexSetupContext['location']): CodexSetupContext => ({
  location,
  endpoint: 'http://127.0.0.1:9317',
  adapterVersion: '0.21.0',
  signal: AbortSignal.timeout(10000),
  onDevice: async () => undefined,
  fetchCatalog: async () => fullCatalog,
});
const activeCatalog = async (location: CodexSetupContext['location']) =>
  (Bun.TOML.parse(await readFile(location.configPath, 'utf8')) as { model_catalog_json: string }).model_catalog_json;

// Removing catalog preparation would leave the config pointing at no complete local catalog.
test('keep-chatgpt writes catalog before committing its path and replaces removed models', async () => {
  const { root, location } = await fixture();
  const previousWrite = catalogStorage.durableWrite;
  const order: string[] = [];
  const write = spyOn(catalogStorage, 'durableWrite').mockImplementation(async (...args) => {
    if (args[0].includes('/model-catalogs/')) order.push('catalog-write');
    return previousWrite(...args);
  });
  const originalToml = catalogStorage.writeTomlAtomically;
  const toml = spyOn(catalogStorage, 'writeTomlAtomically').mockImplementation(async (...args) => {
    order.push('config-write');
    const path = (Bun.TOML.parse(args[2]) as { model_catalog_json: string }).model_catalog_json;
    expect(await Bun.file(path).json()).toEqual(fullCatalog);
    return originalToml(...args);
  });
  try {
    await commitCodexSetup(keepSelection, {
      ...catalogContext(location),
      fetchCatalog: async (input) => {
        expect(input.token).toBe('selected-proxy-token');
        expect(input.endpoint).toBe('http://127.0.0.1:9317');
        order.push('fetch');
        return fullCatalog;
      },
    });
    expect(order).toEqual(['fetch', 'catalog-write', 'config-write']);
    expect(await readFile(await activeCatalog(location), 'utf8')).not.toContain('selected-proxy-token');
    write.mockRestore();
    toml.mockRestore();
    // Codex refuses to start on a catalog without models, so an empty one keeps the previous file.
    await commitCodexSetup(keepSelection, { ...catalogContext(location), fetchCatalog: async () => ({ models: [] }) });
    expect(await Bun.file(await activeCatalog(location)).json()).toEqual(fullCatalog);
  } finally {
    write.mockRestore();
    toml.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts a valid full catalog larger than the HTTP client limit', async () => {
  const { root, location } = await fixture();
  try {
    const large = { models: [{ ...fullCatalog.models[0], base_instructions: 'x'.repeat(1048577) }] };
    await commitCodexSetup(keepSelection, { ...catalogContext(location), fetchCatalog: async () => large });
    expect(await Bun.file(await activeCatalog(location)).json()).toEqual(large);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, response] of [
  ['401', () => new Response('', { status: 401 })],
  ['503', () => new Response('', { status: 503 })],
  ['non-JSON', () => new Response('invalid')],
  ['missing models', () => Response.json({})],
  ['missing required row', () => Response.json({ models: [{ slug: 'bad' }] })],
] as const) {
  test(`catalog fetch failure ${name} leaves configuration unchanged`, async () => {
    const { root, location } = await fixture();
    try {
      await writeFile(location.configPath, 'model_provider = "openai"\n');
      const before = await readFile(location.configPath, 'utf8');
      await expect(
        commitCodexSetup(keepSelection, {
          ...catalogContext(location),
          fetchCatalog: (input) => fetchCodexCatalog(input, (async () => response()) as typeof fetch),
        }),
      ).rejects.toThrow();
      expect(await readFile(location.configPath, 'utf8')).toBe(before);
      expect(await Bun.file(location.markerPath).exists()).toBe(false);
      expect(await Bun.file(authOperationPath(location)).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const prepareActiveCommand = async (context: CodexSetupContext) => {
  const { location } = context;
  await withCodexInstallation(location, context.signal, async (lease) => {
    const installation = await prepareCodexCommandInstallation(
      { location, providerId: 'aio-proxy', endpoint: context.endpoint, adapterVersion: '0.21.0' },
      lease,
    );
    await configureCodexConfig(
      {
        location,
        providerId: 'aio-proxy',
        baseUrl: `${context.endpoint}/v1`,
        auth: { mode: 'command', command: 'aiop', installationId: installation.marker.installationId },
      },
      lease,
    );
    await writeCredential(location, {
      format: 1,
      installationId: installation.marker.installationId,
      endpoint: context.endpoint,
      revision: 1,
      status: 'ready',
      accessToken: `aio_agent_at_v1_${'a'.repeat(43)}`,
      refreshToken: `aio_agent_rt_v1_${'b'.repeat(43)}`,
      accessExpiresAt: Date.now() + 60000,
    });
    await activateCodexCommandInstallation(location, installation.marker.installationId, lease);
  });
};

for (const failure of ['fetch', 'write', 'readback', 'digest', 'config-validation'] as const) {
  test(`catalog preparation failure ${failure} does not retire previous command auth`, async () => {
    const { root, location } = await fixture();
    const context = catalogContext(location);
    let restore = () => {};
    let revoked = 0;
    let retired = 0;
    const originalRetire = commandAuth.retireCodexCommandInstallation;
    const retire = spyOn(commandAuth, 'retireCodexCommandInstallation').mockImplementation(async (...args) => {
      retired += 1;
      return originalRetire(...args);
    });
    try {
      await prepareActiveCommand(context);
      if (failure === 'config-validation') {
        await writeFile(
          location.configPath,
          (await readFile(location.configPath, 'utf8')).replace('AIO Proxy', 'User edit'),
        );
      }
      const before = {
        config: await readFile(location.configPath, 'utf8'),
        marker: await readFile(location.markerPath, 'utf8'),
        credential: await readCredential(location),
        identity: await readCodexCommandIdentity(location),
      };
      if (failure === 'write' || failure === 'digest') {
        const original = catalogStorage.durableWrite;
        const spy = spyOn(catalogStorage, 'durableWrite').mockImplementation(async (...args) => {
          if (args[0].includes('/model-catalogs/')) {
            if (failure === 'write') throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' });
            return original(args[0], '{"models": []}\n', args[2]);
          }
          return original(...args);
        });
        restore = () => spy.mockRestore();
      }
      if (failure === 'readback') {
        const original = catalogStorage.readRegularFile;
        const spy = spyOn(catalogStorage, 'readRegularFile').mockImplementation(async (path) => {
          if (path.includes('/model-catalogs/') && (await Bun.file(path).exists())) throw new Error('readback failed');
          return original(path);
        });
        restore = () => spy.mockRestore();
      }
      await expect(
        commitCodexSetup(keepSelection, {
          ...context,
          fetchCatalog: async () => {
            if (failure === 'fetch') throw new Error('unavailable');
            return fullCatalog;
          },
          revoke: async () => {
            revoked += 1;
            return 'revoked';
          },
        }),
      ).rejects.toThrow();
      expect(revoked).toBe(0);
      expect(retired).toBe(0);
      expect(await readFile(location.configPath, 'utf8')).toBe(before.config);
      expect(await readFile(location.markerPath, 'utf8')).toBe(before.marker);
      expect(await readCredential(location)).toEqual(before.credential);
      expect(await readCodexCommandIdentity(location)).toEqual(before.identity);
      expect(await readCodexCommandIdentity(location)).toMatchObject({ status: 'active' });
      expect(await Bun.file(authOperationPath(location)).exists()).toBe(false);
    } finally {
      restore();
      retire.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const failure of [undefined, 'fetch', 'write'] as const) {
  test(`command fetches catalog after authorization and retains authorized recovery on ${failure ?? 'success'}`, async () => {
    const { root, location } = await fixture();
    const previousFetch = globalThis.fetch;
    const context = catalogContext(location);
    const accessToken = `aio_agent_at_v1_${'c'.repeat(43)}`;
    const order: string[] = [];
    const originalWrite = catalogStorage.durableWrite;
    const write = spyOn(catalogStorage, 'durableWrite').mockImplementation(async (...args) => {
      if (args[0].includes('/model-catalogs/')) {
        order.push('catalog-write');
        if (failure === 'write') throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' });
      }
      return originalWrite(...args);
    });
    try {
      globalThis.fetch = (async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === '/oauth/device/code')
          return Response.json({
            device_code: 'e'.repeat(43),
            user_code: 'ABCD-EFGH',
            verification_uri: `${context.endpoint}/dashboard/agents/authorize`,
            verification_uri_complete: `${context.endpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
            expires_in: 600,
            interval: 5,
          });
        if (path !== '/oauth/token') throw new Error(`unexpected request ${path}`);
        order.push('authorized');
        return Response.json({
          token_type: 'Bearer',
          access_token: accessToken,
          refresh_token: `aio_agent_rt_v1_${'d'.repeat(43)}`,
          expires_in: 900,
        });
      }) as typeof fetch;
      await writeFile(location.configPath, 'model_provider = "openai"\n');
      const before = await readFile(location.configPath, 'utf8');
      const setupContext = {
        ...context,
        fetchCatalog: async (input: Parameters<typeof fetchCodexCatalog>[0]) => {
          expect(input.token).toBe(accessToken);
          expect(await readCredential(location)).toMatchObject({ status: 'ready', accessToken });
          expect(await readFile(location.configPath, 'utf8')).toBe(before);
          order.push('fetch');
          if (failure === 'fetch') throw new Error('unavailable');
          return fullCatalog;
        },
      };
      const setup = commitCodexSetup(
        { providerId: 'aio-proxy', auth: { mode: 'command', command: 'aiop' } },
        setupContext,
      );
      if (failure === undefined) {
        await expect(setup).resolves.toMatchObject({ authMode: 'command', status: 'configured' });
        expect(order).toEqual(['authorized', 'fetch', 'catalog-write']);
        expect(await Bun.file(await activeCatalog(location)).json()).toEqual(fullCatalog);
        expect(await readFile(await activeCatalog(location), 'utf8')).not.toContain(accessToken);
        expect(await Bun.file(authOperationPath(location)).exists()).toBe(false);
      } else {
        await expect(setup).rejects.toThrow();
        expect(await readFile(location.configPath, 'utf8')).toBe(before);
        expect(await readCredential(location)).toMatchObject({ status: 'ready', accessToken });
        expect(await Bun.file(authOperationPath(location)).json()).toMatchObject({
          phase: 'authorized',
          targetMode: 'command',
        });
        expect(await readCodexCommandIdentity(location)).toMatchObject({ status: 'pending' });
        // Recovery must still fetch a valid catalog before replacing the original config.
        write.mockRestore();
        const bin = join(root, 'bin');
        await mkdir(bin);
        await writeFile(join(bin, 'aiop'), '#!/bin/sh\necho "aiop 0.21.0"\n', { mode: 0o755 });
        const previousPath = process.env['PATH'];
        process.env['PATH'] = `${bin}:${previousPath ?? ''}`;
        try {
          await expect(
            recoverCodexAuthOperation(
              {
                ...context,
                fetchCatalog: async () => {
                  throw new Error('unavailable');
                },
              },
              'complete',
            ),
          ).resolves.toBe('blocked');
          expect(await readFile(location.configPath, 'utf8')).toBe(before);
          await expect(recoverCodexAuthOperation(context, 'complete')).resolves.toBe('completed');
          expect(await Bun.file(await activeCatalog(location)).json()).toEqual(fullCatalog);
          expect(await readCodexCommandIdentity(location)).toMatchObject({ status: 'active' });
        } finally {
          process.env['PATH'] = previousPath;
        }
      }
    } finally {
      write.mockRestore();
      globalThis.fetch = previousFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('validates the prepared full catalog and config before retiring, revoking and committing the previous command installation', async () => {
  const { root, location } = await fixture();
  const context = catalogContext(location);
  const order: string[] = [];
  const originalWrite = catalogStorage.durableWrite;
  const originalRead = catalogStorage.readRegularFile;
  const originalValidate = managedConfig.validateCodexConfig;
  const originalRetire = commandAuth.retireCodexCommandInstallation;
  const originalToml = catalogStorage.writeTomlAtomically;
  const restores: (() => void)[] = [];
  try {
    await prepareActiveCommand(context);
    const before = await readFile(location.configPath, 'utf8');
    const write = spyOn(catalogStorage, 'durableWrite').mockImplementation(async (...args) => {
      await originalWrite(...args);
      if (args[0].includes('/model-catalogs/')) order.push('durable-write');
    });
    restores.push(() => write.mockRestore());
    const read = spyOn(catalogStorage, 'readRegularFile').mockImplementation(async (...args) => {
      const result = await originalRead(...args);
      if (args[0].includes('/model-catalogs/') && result !== undefined && !order.includes('file-readback')) {
        order.push('file-readback');
        expect(JSON.parse(result.text)).toEqual(fullCatalog);
      }
      return result;
    });
    restores.push(() => read.mockRestore());
    const validate = spyOn(managedConfig, 'validateCodexConfig').mockImplementation(async (...args) => {
      const result = await originalValidate(...args);
      expect(args[0].catalogPath).toBeString();
      expect(await readFile(location.configPath, 'utf8')).toBe(before);
      order.push('config-validated');
      return result;
    });
    restores.push(() => validate.mockRestore());
    const retire = spyOn(commandAuth, 'retireCodexCommandInstallation').mockImplementation(async (...args) => {
      expect(await readCredential(location)).toMatchObject({ status: 'ready' });
      expect(await Bun.file(authOperationPath(location)).json()).toMatchObject({ phase: 'retiring' });
      order.push('retire');
      return originalRetire(...args);
    });
    restores.push(() => retire.mockRestore());
    const toml = spyOn(catalogStorage, 'writeTomlAtomically').mockImplementation(async (...args) => {
      expect(await readCodexCommandIdentity(location)).toBeUndefined();
      order.push('commit');
      return originalToml(...args);
    });
    restores.push(() => toml.mockRestore());
    await commitCodexSetup(keepSelection, {
      ...context,
      fetchCatalog: async () => {
        expect(await readCodexCommandIdentity(location)).toMatchObject({ status: 'active' });
        order.push('fetch');
        return fullCatalog;
      },
      revoke: async () => {
        expect(await readCodexCommandIdentity(location)).toMatchObject({ status: 'retiring' });
        order.push('revoke');
        return 'revoked';
      },
    });
    expect(order).toEqual([
      'fetch',
      'durable-write',
      'file-readback',
      'config-validated',
      'retire',
      'revoke',
      'commit',
    ]);
    expect(await Bun.file(await activeCatalog(location)).json()).toEqual(fullCatalog);
    expect(await readCredential(location)).toBeUndefined();
  } finally {
    for (const restore of restores.reverse()) restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty catalog on first setup leaves model_catalog_json unset; a later catalog is written', async () => {
  const { root, location } = await fixture();
  try {
    await commitCodexSetup(keepSelection, { ...catalogContext(location), fetchCatalog: async () => ({ models: [] }) });
    expect(await activeCatalog(location)).toBeUndefined();
    await commitCodexSetup(keepSelection, catalogContext(location));
    expect(await Bun.file(await activeCatalog(location)).json()).toEqual(fullCatalog);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
