import { expect, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexLocation } from '../location';
import { withCodexInstallation } from '../storage/installation-lock';
import {
  activateCodexCommandInstallation,
  authorizeCodexInstallation,
  inspectCodexCommandCredential,
  prepareCodexCommandInstallation,
  readCodexCommandIdentity,
  writeCodexAuthToken,
} from './command-auth';

const ACCESS = `aio_agent_at_v1_${'a'.repeat(43)}`;
const REFRESH = `aio_agent_rt_v1_${'b'.repeat(43)}`;
const DEVICE = 'd'.repeat(43);

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

test.serial('refreshes concurrently under the installation lock and persists rotation before delivery', async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
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
          : { token_type: 'Bearer', access_token: ACCESS, refresh_token: REFRESH, expires_in: 900 },
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
      await authorizeCodexInstallation(
        {
          location: f.location,
          installation,
          signal: AbortSignal.timeout(10_000),
          onDevice: async () => undefined,
        },
        lease,
      );
      await activateCodexCommandInstallation(f.location, installation.marker.installationId, lease);
    });
    const delivered: string[] = [];
    await Promise.all(
      [1, 2].map(() =>
        withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) => {
          const result = await writeCodexAuthToken({
            location: f.location,
            installationId,
            signal: AbortSignal.timeout(10_000),
            writeToken: async (token) => {
              const stored = JSON.parse(await readFile(join(f.location.managedRoot, 'codex-credential.json'), 'utf8'));
              expect(stored.refreshToken).not.toBe('old-refresh');
              delivered.push(token);
            },
            lease,
          });
          return result;
        }),
      ),
    );
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(new Set(delivered).size).toBe(1);
    let refreshedAfterUnauthorized = '';
    await withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) =>
      writeCodexAuthToken({
        location: f.location,
        installationId,
        signal: AbortSignal.timeout(10_000),
        forceRefresh: true,
        writeToken: async (token) => {
          refreshedAfterUnauthorized = token;
        },
        lease,
      }),
    );
    expect(refreshedAfterUnauthorized).toBe(ACCESS);
    await expect(
      withCodexInstallation(f.location, AbortSignal.timeout(10_000), async (lease) =>
        writeCodexAuthToken({
          location: f.location,
          installationId,
          signal: AbortSignal.timeout(10_000),
          forceRefresh: true,
          writeToken: async () => {
            throw new Error(`secret ${ACCESS}`);
          },
          lease,
        }),
      ),
    ).rejects.toThrow('Codex token delivery failed');
    expect(await readFile(join(f.location.managedRoot, 'codex-credential.json'), 'utf8')).toContain(ACCESS);
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
          verification_uri: `http://127.0.0.1:${server.port}/dashboard/agents/authorize`,
          verification_uri_complete: `http://127.0.0.1:${server.port}/dashboard/agents/authorize#code=ABCD-EFGH`,
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
      await authorizeCodexInstallation(
        { location, installation, signal: AbortSignal.timeout(10_000), onDevice: async () => undefined },
        lease,
      );
      await activateCodexCommandInstallation(location, installationId, lease);
    });
    const commandAuthPath = join(import.meta.dir, 'command-auth.ts');
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
