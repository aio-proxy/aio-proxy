import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activateCodexCommandInstallation,
  prepareCodexCommandInstallation,
  readCodexCommandIdentity,
} from '../command-auth';
import { credentialPath, readCredential, writeCredential } from '../command-auth/credential-store';
import type { CodexSetupContext } from '../contracts';
import { resolveCodexLocation } from '../location';
import { inspectCodexConfig } from '../managed-config';
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
    await expect(
      recoverCodexAuthOperation(
        {
          location,
          endpoint,
          adapterVersion: '0.21.0',
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
        },
        'complete',
      ),
    ).resolves.toBe('completed');
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
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({ authMode: 'keep-chatgpt' });
    await expect(readCredential(location)).resolves.toBeUndefined();
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ authMode: 'keep-chatgpt' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rebinds a command installation when the managed Provider ID changes', async () => {
  const { root, location } = await fixture();
  const endpoint = 'http://127.0.0.1:9317';
  try {
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
        signal: AbortSignal.timeout(10_000),
        onDevice: async () => undefined,
      },
    );
    await expect(readCodexCommandIdentity(location)).resolves.toMatchObject({ providerId: 'new-id' });
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ providerId: 'new-id', authMode: 'command' });
  } finally {
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
