import { expect, test } from 'bun:test';
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pollDeviceAuthorization } from '@aio-proxy/agent-provider-runtime';

import { resolveCodexLocation } from '../location';
import { configureCodexConfig } from '../managed-config';
import { withCodexInstallation } from '../storage/installation-lock';
import {
  activateCodexCommandInstallation,
  authorizeCodexInstallation,
  clearCodexCommandInstallation,
  inspectCodexCommandCredential,
  prepareCodexCommandInstallation,
  readCodexCommandIdentity,
} from './command-auth';
import { readCredential, writeCredential } from './credential-store';
import { writeCodexAuthToken } from './token-delivery';

const ACCESS = `aio_agent_at_v1_${'a'.repeat(43)}`;
const ROTATED_ACCESS = `aio_agent_at_v1_${'z'.repeat(43)}`;
const REFRESH = `aio_agent_rt_v1_${'b'.repeat(43)}`;
const ROTATED_REFRESH = `aio_agent_rt_v1_${'y'.repeat(43)}`;
const DEVICE = 'd'.repeat(43);

const instantDevicePoll = async (...args: Parameters<typeof pollDeviceAuthorization>) =>
  pollDeviceAuthorization(args[0], args[1], {
    ...args[2],
    sleep: async () => undefined,
  });

async function fixture() {
  const root = join(tmpdir(), `aio-codex-auth-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const location = resolveCodexLocation(root, { HOME: root });
  const marker = {
    agent: 'codex' as const,
    installationId: crypto.randomUUID(),
    adapterVersion: '0.21.0',
    endpoint: 'http://127.0.0.1:9317',
  };
  return { root, location, marker };
}

test.serial('persists pending identity before device authorization and never emits device secrets', async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/oauth/device/code')
      return new Response(
        JSON.stringify({
          device_code: DEVICE,
          user_code: 'ABCD-EFGH',
          verification_uri: `${f.marker.endpoint}/dashboard/agents/authorize`,
          verification_uri_complete: `${f.marker.endpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    return new Response(
      JSON.stringify({ token_type: 'Bearer', access_token: ACCESS, refresh_token: REFRESH, expires_in: 900 }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      await configureCodexConfig(
        {
          location: f.location,
          providerId: 'aio-proxy',
          baseUrl: `${f.marker.endpoint}/v1`,
          auth: {
            mode: 'command',
            installationId: installation.marker.installationId,
            command: '/tmp/AIO Proxy/bin/aiop',
          },
        },
        lease,
      );
      expect((await readCodexCommandIdentity(f.location))?.status).toBe('pending');
      let delivered = false;
      await authorizeCodexInstallation(
        {
          location: f.location,
          installation,
          signal: AbortSignal.timeout(10_000),
          onDevice: async (device) => {
            expect(device.device_code).toBe(DEVICE);
            expect(device.user_code).toBe('ABCD-EFGH');
            delivered = true;
          },
          pollDeviceAuthorization: instantDevicePoll,
        },
        lease,
      );
      expect(delivered).toBe(true);
      await activateCodexCommandInstallation(f.location, installation.marker.installationId, lease);
      const credential = JSON.parse(await readFile(join(f.location.managedRoot, 'codex-credential.json'), 'utf8'));
      expect(credential.refreshToken).toBe(REFRESH);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test.serial('authorizes a command installation while the managed config is still keep-chatgpt', async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/oauth/device/code')
      return Response.json({
        device_code: DEVICE,
        user_code: 'ABCD-EFGH',
        verification_uri: `${f.marker.endpoint}/dashboard/agents/authorize`,
        verification_uri_complete: `${f.marker.endpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
        expires_in: 600,
        interval: 5,
      });
    return Response.json({
      token_type: 'Bearer',
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: 900,
    });
  }) as typeof fetch;
  try {
    await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
      await configureCodexConfig(
        {
          location: f.location,
          providerId: 'keep-id',
          baseUrl: `${f.marker.endpoint}/v1`,
          auth: { mode: 'keep-chatgpt', token: 'aio-proxy-local' },
        },
        lease,
      );
      const installation = await prepareCodexCommandInstallation(
        { location: f.location, providerId: 'command-id', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      let delivered = false;
      await authorizeCodexInstallation(
        {
          location: f.location,
          installation,
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => {
            delivered = true;
          },
          pollDeviceAuthorization: instantDevicePoll,
        },
        lease,
      );
      expect(delivered).toBe(true);
      await expect(readCredential(f.location)).resolves.toMatchObject({ status: 'ready', accessToken: ACCESS });
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('listing an unconfigured Codex home does not create its managed directory', async () => {
  const f = await fixture();
  expect(await readCodexCommandIdentity(f.location)).toBeUndefined();
  expect(await Bun.file(f.location.managedRoot).exists()).toBe(false);
});

test('uses the helper deadline while waiting for the installation lock', async () => {
  const f = await fixture();
  let release!: () => void;
  let locked!: () => void;
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = withCodexInstallation(f.location, AbortSignal.timeout(10_000), async () => {
    locked();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  try {
    await acquired;
    const deadline = AbortSignal.timeout(25);
    await expect(
      writeCodexAuthToken({
        location: f.location,
        installationId: crypto.randomUUID(),
        signal: deadline,
        writeToken: async () => undefined,
      }),
    ).rejects.toThrow();
    expect(deadline.aborted).toBe(true);
  } finally {
    release();
    await held;
  }
});

test.serial('refreshes concurrently under the installation lock and persists rotation before delivery', async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  let refreshCount = 0;
  globalThis.fetch = (async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/oauth/token') refreshCount += 1;
    return new Response(
      JSON.stringify(
        path === '/oauth/device/code'
          ? {
              device_code: DEVICE,
              user_code: 'ABCD-EFGH',
              verification_uri: `${f.marker.endpoint}/dashboard/agents/authorize`,
              verification_uri_complete: `${f.marker.endpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
              expires_in: 600,
              interval: 5,
            }
          : {
              token_type: 'Bearer',
              access_token: refreshCount > 1 ? ROTATED_ACCESS : ACCESS,
              refresh_token: refreshCount > 1 ? ROTATED_REFRESH : REFRESH,
              expires_in: 900,
            },
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  let installationId = '';
  try {
    await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location: f.location,
          providerId: 'aio-proxy',
          baseUrl: `${f.marker.endpoint}/v1`,
          auth: {
            mode: 'command',
            installationId: installation.marker.installationId,
            command: '/tmp/AIO Proxy/bin/aiop',
          },
        },
        lease,
      );
      await authorizeCodexInstallation(
        {
          location: f.location,
          installation,
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
          pollDeviceAuthorization: instantDevicePoll,
        },
        lease,
      );
      await activateCodexCommandInstallation(f.location, installation.marker.installationId, lease);
    });
    const ready = await readCredential(f.location);
    await writeCredential(f.location, { ...ready!, accessExpiresAt: Date.now() - 1 });
    const refreshAfterSetup = refreshCount;
    const delivered: string[] = [];
    await Promise.all(
      [1, 2].map(() =>
        writeCodexAuthToken({
          location: f.location,
          installationId,
          signal: AbortSignal.timeout(10_000),
          writeToken: async (token) => {
            const stored = JSON.parse(await readFile(join(f.location.managedRoot, 'codex-credential.json'), 'utf8'));
            expect(stored.refreshToken).not.toBe('old-refresh');
            delivered.push(token);
          },
        }),
      ),
    );
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(new Set(delivered).size).toBe(1);
    expect(refreshCount - refreshAfterSetup).toBe(1);
    const deliveredState = await readCredential(f.location);
    expect(deliveredState).toBeDefined();
    await writeCredential(f.location, { ...deliveredState!, deliveredAt: Date.now() - 60_000 });
    const refreshAfterBurst = refreshCount;
    await writeCodexAuthToken({
      location: f.location,
      installationId,
      signal: AbortSignal.timeout(10_000),
      writeToken: async () => undefined,
    });
    expect(refreshCount - refreshAfterBurst).toBe(0);
    let refreshedAfterUnauthorized = '';
    await writeCodexAuthToken({
      location: f.location,
      installationId,
      signal: AbortSignal.timeout(10_000),
      forceRefresh: true,
      writeToken: async (token) => {
        refreshedAfterUnauthorized = token;
      },
    });
    expect(refreshedAfterUnauthorized).toBe(ROTATED_ACCESS);
    await expect(
      writeCodexAuthToken({
        location: f.location,
        installationId,
        signal: AbortSignal.timeout(10_000),
        forceRefresh: true,
        writeToken: async () => {
          throw new Error(`secret ${ACCESS}`);
        },
      }),
    ).rejects.toThrow('Codex token delivery failed');
    expect(await readFile(join(f.location.managedRoot, 'codex-credential.json'), 'utf8')).toContain(ROTATED_ACCESS);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test.serial('refreshes after a probe rejects a still-cached access token', async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  let refreshCount = 0;
  globalThis.fetch = (async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/v1/models') return new Response('unauthorized', { status: 401 });
    if (path === '/oauth/token') refreshCount += 1;
    return Response.json({
      token_type: 'Bearer',
      access_token: ROTATED_ACCESS,
      refresh_token: ROTATED_REFRESH,
      expires_in: 900,
    });
  }) as typeof fetch;
  try {
    let installationId = '';
    await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location: f.location,
          providerId: 'aio-proxy',
          baseUrl: `${f.marker.endpoint}/v1`,
          auth: { mode: 'command', installationId, command: '/tmp/AIO Proxy/bin/aiop' },
        },
        lease,
      );
      await writeCredential(f.location, {
        format: 1,
        installationId,
        endpoint: f.marker.endpoint,
        revision: 1,
        accessToken: ACCESS,
        refreshToken: REFRESH,
        accessExpiresAt: Date.now() + 600_000,
        status: 'ready',
        deliveredBy: 'prior-helper',
        deliveredRevision: 1,
        deliveredAt: Date.now() - 60_000,
      });
      await activateCodexCommandInstallation(f.location, installationId, lease);
    });
    const delivered: string[] = [];
    await writeCodexAuthToken({
      location: f.location,
      installationId,
      signal: AbortSignal.timeout(10_000),
      writeToken: async (token) => {
        delivered.push(token);
      },
    });
    expect(refreshCount).toBe(1);
    expect(delivered).toEqual([ROTATED_ACCESS]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test.serial('reuses an unexpired access token across independent helper cycles', async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  let refreshCount = 0;
  globalThis.fetch = (async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/oauth/token') refreshCount += 1;
    return Response.json(
      path === '/oauth/device/code'
        ? {
            device_code: DEVICE,
            user_code: 'ABCD-EFGH',
            verification_uri: `${f.marker.endpoint}/dashboard/agents/authorize`,
            verification_uri_complete: `${f.marker.endpoint}/dashboard/agents/authorize#code=ABCD-EFGH`,
            expires_in: 600,
            interval: 5,
          }
        : {
            token_type: 'Bearer',
            access_token: refreshCount > 0 ? ROTATED_ACCESS : ACCESS,
            refresh_token: refreshCount > 0 ? ROTATED_REFRESH : REFRESH,
            expires_in: 900,
          },
    );
  }) as typeof fetch;
  try {
    let installationId = '';
    await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location: f.location,
          providerId: 'aio-proxy',
          baseUrl: `${f.marker.endpoint}/v1`,
          auth: { mode: 'command', installationId, command: '/tmp/AIO Proxy/bin/aiop' },
        },
        lease,
      );
      await writeCredential(f.location, {
        format: 1,
        installationId,
        endpoint: f.marker.endpoint,
        revision: 1,
        accessToken: ACCESS,
        refreshToken: REFRESH,
        accessExpiresAt: Date.now() + 600_000,
        status: 'ready',
        deliveredBy: 'prior-helper',
        deliveredRevision: 1,
        deliveredAt: Date.now() - 60_000,
      });
      await activateCodexCommandInstallation(f.location, installationId, lease);
    });
    const delivered: string[] = [];
    await writeCodexAuthToken({
      location: f.location,
      installationId,
      signal: AbortSignal.timeout(10_000),
      writeToken: async (token) => {
        delivered.push(token);
      },
    });
    expect(refreshCount).toBe(0);
    expect(delivered).toEqual([ACCESS]);
    await expect(readCredential(f.location)).resolves.toMatchObject({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      revision: 1,
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test.serial('coordinates refresh delivery across two helper processes', async () => {
  const root = join(tmpdir(), `aio-codex-cross-process-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let refreshCount = 0;
  const accessOne = `aio_agent_at_v1_${'c'.repeat(43)}`;
  const refreshOne = `aio_agent_rt_v1_${'d'.repeat(43)}`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/oauth/device/code') {
        return Response.json({
          device_code: DEVICE,
          user_code: 'ABCD-EFGH',
          verification_uri: `${new URL(request.url).origin}/dashboard/agents/authorize`,
          verification_uri_complete: `${new URL(request.url).origin}/dashboard/agents/authorize#code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      }
      if (path !== '/oauth/token') return new Response('missing', { status: 404 });
      const form = await request.text();
      if (form.includes('device_code='))
        return Response.json({ token_type: 'Bearer', access_token: ACCESS, refresh_token: REFRESH, expires_in: 900 });
      refreshCount++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return Response.json({
        token_type: 'Bearer',
        access_token: accessOne,
        refresh_token: refreshOne,
        expires_in: 900,
      });
    },
  });
  try {
    const location = resolveCodexLocation(root, { HOME: root });
    let installationId = '';
    await withCodexInstallation(location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        {
          location,
          providerId: 'aio-proxy',
          endpoint: `http://127.0.0.1:${server.port}`,
          adapterVersion: '0.21.0',
        },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'aio-proxy',
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          auth: {
            mode: 'command',
            installationId: installation.marker.installationId,
            command: '/tmp/AIO Proxy/bin/aiop',
          },
        },
        lease,
      );
      await authorizeCodexInstallation(
        {
          location,
          installation,
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
          pollDeviceAuthorization: instantDevicePoll,
        },
        lease,
      );
      await activateCodexCommandInstallation(location, installationId, lease);
    });
    const ready = await readCredential(location);
    await writeCredential(location, { ...ready!, accessExpiresAt: Date.now() - 1 });
    const commandAuthPath = join(import.meta.dir, 'token-delivery.ts');
    const locationPath = join(import.meta.dir, '../location/index.ts');
    const script = `
      const { writeCodexAuthToken } = await import(${JSON.stringify(commandAuthPath)});
      const { resolveCodexLocation } = await import(${JSON.stringify(locationPath)});
      const root = ${JSON.stringify(root)};
      const location = resolveCodexLocation(root, { HOME: root });
      await writeCodexAuthToken({
        location,
        installationId: ${JSON.stringify(installationId)},
        signal: AbortSignal.timeout(10000),
        writeToken: async (token) => process.stdout.write(token + '\\n'),
      });
    `;
    const run = async () => {
      const child = Bun.spawn([process.execPath, '-e', script], {
        cwd: join(import.meta.dir, '../../../../../../'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exit !== 0) throw new Error(`helper failed: ${stderr}`);
      return stdout.trim();
    };
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toBe(accessOne);
    expect(second).toBe(accessOne);
    expect(refreshCount).toBe(1);
    expect(JSON.parse(await readFile(join(location.managedRoot, 'codex-credential.json'), 'utf8')).refreshToken).toBe(
      refreshOne,
    );
  } finally {
    server.stop(true);
  }
});

test.serial('reuses one refresh when three helpers observe the same lock owner', async () => {
  const root = join(tmpdir(), `aio-codex-burst-owner-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const readyDir = join(root, 'helper-ready');
  const goPath = join(root, 'helper-go');
  await mkdir(readyDir, { recursive: true, mode: 0o700 });
  let refreshCount = 0;
  const accessOne = `aio_agent_at_v1_${'e'.repeat(43)}`;
  const refreshOne = `aio_agent_rt_v1_${'f'.repeat(43)}`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/oauth/device/code') {
        return Response.json({
          device_code: DEVICE,
          user_code: 'ABCD-EFGH',
          verification_uri: `${new URL(request.url).origin}/dashboard/agents/authorize`,
          verification_uri_complete: `${new URL(request.url).origin}/dashboard/agents/authorize#code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      }
      if (path !== '/oauth/token') return new Response('missing', { status: 404 });
      const form = await request.text();
      if (form.includes('device_code='))
        return Response.json({ token_type: 'Bearer', access_token: ACCESS, refresh_token: REFRESH, expires_in: 900 });
      refreshCount++;
      return Response.json({
        token_type: 'Bearer',
        access_token: accessOne,
        refresh_token: refreshOne,
        expires_in: 900,
      });
    },
  });
  try {
    const location = resolveCodexLocation(root, { HOME: root });
    const commandAuthPath = join(import.meta.dir, 'token-delivery.ts');
    const locationPath = join(import.meta.dir, '../location/index.ts');
    const script = `
      const { existsSync } = await import('node:fs');
      const { writeFile } = await import('node:fs/promises');
      const { writeCodexAuthToken } = await import(${JSON.stringify(commandAuthPath)});
      const { resolveCodexLocation } = await import(${JSON.stringify(locationPath)});
      await writeFile(${JSON.stringify(readyDir)} + '/' + (process.env.HELPER_ID ?? 'x'), 'ready');
      while (!existsSync(${JSON.stringify(goPath)})) await new Promise((resolve) => setTimeout(resolve, 10));
      const location = resolveCodexLocation(${JSON.stringify(root)}, { HOME: ${JSON.stringify(root)} });
      await writeCodexAuthToken({
        location,
        installationId: process.env.INSTALLATION_ID ?? '',
        signal: AbortSignal.timeout(10000),
        writeToken: async (token) => process.stdout.write(token + '\\n'),
      });
    `;
    let installationId = '';
    let helpers: Promise<string>[] = [];
    const run = (id: string) => {
      const child = Bun.spawn([process.execPath, '-e', script], {
        cwd: join(import.meta.dir, '../../../../../../'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, HELPER_ID: id, INSTALLATION_ID: installationId },
      });
      return (async () => {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exit !== 0) throw new Error(`helper ${id} failed: ${stderr}`);
        return stdout.trim();
      })();
    };
    await withCodexInstallation(location, AbortSignal.timeout(15_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        {
          location,
          providerId: 'aio-proxy',
          endpoint: `http://127.0.0.1:${server.port}`,
          adapterVersion: '0.21.0',
        },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location,
          providerId: 'aio-proxy',
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          auth: {
            mode: 'command',
            installationId,
            command: '/tmp/AIO Proxy/bin/aiop',
          },
        },
        lease,
      );
      await authorizeCodexInstallation(
        {
          location,
          installation,
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
          pollDeviceAuthorization: instantDevicePoll,
        },
        lease,
      );
      await activateCodexCommandInstallation(location, installationId, lease);
      await writeCodexAuthToken({
        location,
        installationId,
        signal: AbortSignal.timeout(10_000),
        lease,
        writeToken: async () => undefined,
      });
      const ready = await readCredential(location);
      await writeCredential(location, { ...ready!, accessExpiresAt: Date.now() - 1 });
      helpers = ['a', 'b', 'c'].map((id) => run(id));
      const startedAt = Date.now();
      while ((await readdir(readyDir)).length < 3) {
        if (Date.now() - startedAt > 10_000) throw new Error('helpers did not become ready');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await writeFile(goPath, 'go');
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const tokens = await Promise.all(helpers);
    expect(new Set(tokens)).toEqual(new Set([accessOne]));
    expect(refreshCount).toBe(1);
    expect(JSON.parse(await readFile(join(location.managedRoot, 'codex-credential.json'), 'utf8')).refreshToken).toBe(
      refreshOne,
    );
  } finally {
    server.stop(true);
  }
});

test('rejects a non-object persisted credential', async () => {
  const f = await fixture();
  try {
    await mkdir(f.location.managedRoot, { recursive: true, mode: 0o700 });
    const path = join(f.location.managedRoot, 'codex-credential.json');
    await writeFile(path, '[1]\n', { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(readCredential(f.location)).rejects.toThrow(/invalid/i);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('read-only inspection does not rotate credentials and rejects symlink credential files', async () => {
  const f = await fixture();
  await expect(
    inspectCodexCommandCredential({ location: f.location, check: true, signal: AbortSignal.timeout(100) }),
  ).resolves.toEqual({ credentialStatus: 'missing', connection: 'not_checked' });
  await mkdir(f.location.managedRoot, { recursive: true });
  await writeFile(join(f.root, 'secret'), '{}');
  await symlink(join(f.root, 'secret'), join(f.location.managedRoot, 'codex-credential.json'));
  await expect(
    inspectCodexCommandCredential({ location: f.location, check: false, signal: AbortSignal.timeout(100) }),
  ).rejects.toThrow(/symbolic|unsafe|symlink/i);
});

test('read-only inspection rejects a class-instance model response', async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => new (class Catalog {})(),
    }) as Response) as typeof fetch;
  try {
    let installationId = '';
    await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location: f.location,
          providerId: 'aio-proxy',
          baseUrl: `${f.marker.endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
      await writeCredential(f.location, {
        format: 1,
        installationId,
        endpoint: f.marker.endpoint,
        revision: 1,
        accessToken: ACCESS,
        refreshToken: REFRESH,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
      await activateCodexCommandInstallation(f.location, installationId, lease);
    });
    await expect(
      inspectCodexCommandCredential({ location: f.location, check: true, signal: AbortSignal.timeout(10_000) }),
    ).resolves.toEqual({ credentialStatus: 'ready', connection: 'invalid_response' });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('read-only inspection rejects an empty object model response', async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  try {
    let installationId = '';
    await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location: f.location,
          providerId: 'aio-proxy',
          baseUrl: `${f.marker.endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
      await writeCredential(f.location, {
        format: 1,
        installationId,
        endpoint: f.marker.endpoint,
        revision: 1,
        accessToken: ACCESS,
        refreshToken: REFRESH,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
      await activateCodexCommandInstallation(f.location, installationId, lease);
    });
    await expect(
      inspectCodexCommandCredential({ location: f.location, check: true, signal: AbortSignal.timeout(10_000) }),
    ).resolves.toEqual({ credentialStatus: 'ready', connection: 'invalid_response' });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('read-only inspection rejects array model responses', async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([])) as typeof fetch;
  try {
    let installationId = '';
    await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
      const installation = await prepareCodexCommandInstallation(
        { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
        lease,
      );
      installationId = installation.marker.installationId;
      await configureCodexConfig(
        {
          location: f.location,
          providerId: 'aio-proxy',
          baseUrl: `${f.marker.endpoint}/v1`,
          auth: { mode: 'command', installationId, command: 'aiop' },
        },
        lease,
      );
      await writeCredential(f.location, {
        format: 1,
        installationId,
        endpoint: f.marker.endpoint,
        revision: 1,
        accessToken: ACCESS,
        refreshToken: REFRESH,
        accessExpiresAt: Date.now() + 60_000,
        status: 'ready',
      });
      await activateCodexCommandInstallation(f.location, installationId, lease);
    });
    await expect(
      inspectCodexCommandCredential({ location: f.location, check: true, signal: AbortSignal.timeout(10_000) }),
    ).resolves.toEqual({ credentialStatus: 'ready', connection: 'invalid_response' });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('does not deliver an active credential without a matching managed config', async () => {
  const f = await fixture();
  let installationId = '';
  await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
    const installation = await prepareCodexCommandInstallation(
      { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
      lease,
    );
    installationId = installation.marker.installationId;
    await writeCredential(f.location, {
      format: 1,
      installationId,
      endpoint: f.marker.endpoint,
      revision: 1,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessExpiresAt: Date.now() + 60_000,
      status: 'ready',
    });
    await writeFile(
      join(f.location.managedRoot, 'codex-command.json'),
      `${JSON.stringify({ ...installation, status: 'active' })}\n`,
    );
    await chmod(join(f.location.managedRoot, 'codex-command.json'), 0o600);
  });
  await expect(
    writeCodexAuthToken({
      location: f.location,
      installationId,
      signal: AbortSignal.timeout(10_000),
      writeToken: async () => undefined,
    }),
  ).rejects.toThrow(/managed configuration/i);
});

test('refuses to delete an insecure credential file during cleanup', async () => {
  const f = await fixture();
  await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
    const installation = await prepareCodexCommandInstallation(
      { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
      lease,
    );
    await writeCredential(f.location, {
      format: 1,
      installationId: installation.marker.installationId,
      endpoint: f.marker.endpoint,
      revision: 1,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessExpiresAt: Date.now() + 60_000,
      status: 'ready',
    });
    await writeFile(
      join(f.location.managedRoot, 'codex-command.json'),
      `${JSON.stringify({ ...installation, status: 'active' })}\n`,
    );
    await chmod(join(f.location.managedRoot, 'codex-command.json'), 0o600);
    await chmod(join(f.location.managedRoot, 'codex-credential.json'), 0o644);
    await expect(
      clearCodexCommandInstallation(
        { location: f.location, installationId: installation.marker.installationId, revocation: 'revoked' },
        lease,
      ),
    ).rejects.toThrow(/unsafe|insecure/i);
  });
});

test('refuses to clear a credential whose installation does not match identity', async () => {
  const f = await fixture();
  const otherInstallationId = crypto.randomUUID();
  await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
    const installation = await prepareCodexCommandInstallation(
      { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
      lease,
    );
    await writeCredential(f.location, {
      format: 1,
      installationId: otherInstallationId,
      endpoint: f.marker.endpoint,
      revision: 1,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessExpiresAt: Date.now() + 60_000,
      status: 'ready',
    });
    await expect(
      clearCodexCommandInstallation(
        { location: f.location, installationId: installation.marker.installationId, revocation: 'revoked' },
        lease,
      ),
    ).rejects.toThrow(/installation mismatch/i);
  });
  await expect(readCredential(f.location)).resolves.toMatchObject({ installationId: otherInstallationId });
});

test.serial('marks an abandoned refresh outside the replay window for reauthorization', async () => {
  const f = await fixture();
  await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
    const installation = await prepareCodexCommandInstallation(
      { location: f.location, providerId: 'aio-proxy', endpoint: f.marker.endpoint, adapterVersion: '0.21.0' },
      lease,
    );
    await writeCredential(f.location, {
      format: 1,
      installationId: installation.marker.installationId,
      endpoint: f.marker.endpoint,
      revision: 1,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessExpiresAt: Date.now() + 60_000,
      status: 'refreshing',
      refreshStartedAt: Date.now() - 31_000,
    });
    await configureCodexConfig(
      {
        location: f.location,
        providerId: 'aio-proxy',
        baseUrl: `${f.marker.endpoint}/v1`,
        auth: {
          mode: 'command',
          installationId: installation.marker.installationId,
          command: '/tmp/AIO Proxy/bin/aiop',
        },
      },
      lease,
    );
    await writeFile(
      join(f.location.managedRoot, 'codex-command.json'),
      JSON.stringify({
        format: 1,
        marker: {
          format: 1,
          managedBy: 'aio-proxy',
          ...f.marker,
          agent: 'codex',
          installationId: installation.marker.installationId,
        },
        configPath: f.location.configPath,
        providerId: 'aio-proxy',
        status: 'active',
      }),
    );
    await chmod(join(f.location.managedRoot, 'codex-command.json'), 0o600);
    await expect(
      writeCodexAuthToken({
        location: f.location,
        installationId: installation.marker.installationId,
        signal: AbortSignal.timeout(10_000),
        writeToken: async () => undefined,
        lease,
      }),
    ).rejects.toThrow(/replay_lost|reauthorize/i);
    expect(JSON.parse(await readFile(join(f.location.managedRoot, 'codex-credential.json'), 'utf8')).status).toBe(
      'reauthorize',
    );
  });
});
