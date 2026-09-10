import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareCodexCommandInstallation } from '../command-auth';
import type { CodexSetupContext } from '../contracts';
import { resolveCodexLocation } from '../location';
import { withCodexInstallation } from '../storage/installation-lock';
import { authOperationPath, writeAuthOperation } from './journal';
import { recoverCodexAuthOperation } from './setup';

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
