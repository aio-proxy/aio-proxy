import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '@aio-proxy/server';
import { Command } from 'commander';

import { loopbackServer } from '../../../server/src/dashboard-auth/test-support';
import { createDefaultSyncCliDeps, createSyncClient } from './client';
import { registerSyncCommands } from './commands';

test('leave excludes the Provider without invoking cloud purge', async () => {
  const calls: string[] = [];
  const output: string[] = [];
  const program = new Command();
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async (path, init) => {
      calls.push(path + ' ' + String(init.body));
      return Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
    },
    write: (value) => output.push(value),
  });
  await program.parseAsync(['node', 'aio-proxy', 'sync', 'leave', 'work']);
  expect(calls).toEqual(['/dashboard/api/sync/range {"providerId":"work","included":false}']);
  expect(output).toHaveLength(1);
});

test('connect reads options locally and only returns the redacted preview', async () => {
  const calls: Array<{ path: string; body: string | undefined }> = [];
  const output: string[] = [];
  const optionsFile = `${import.meta.dir}/.sync-options-test.json`;
  const originalOptions = JSON.stringify({ account: 'local', apiKey: 'backend-secret' });
  await Bun.write(optionsFile, originalOptions);
  try {
    const program = new Command();
    registerSyncCommands(program, {
      endpoint: async () => 'http://127.0.0.1:9317',
      authenticate: async () => undefined,
      request: async (path, init) => {
        calls.push({ path, body: typeof init.body === 'string' ? init.body : undefined });
        return Response.json({
          previewId: 'preview-1',
          kind: 'connect',
          rows: [],
          retainedSharedPlugins: [],
          expiresAt: 10,
        });
      },
      write: (value) => output.push(value),
    });
    await program.parseAsync([
      'node',
      'aio-proxy',
      'sync',
      'connect',
      '--plugin',
      'cloud-plugin',
      '--capability',
      'cloud',
      '--options-file',
      optionsFile,
    ]);
    expect(calls).toEqual([
      {
        path: '/dashboard/api/sync/preview',
        body: JSON.stringify({
          kind: 'connect',
          plugin: 'cloud-plugin',
          capability: 'cloud',
          options: { account: 'local', apiKey: 'backend-secret' },
        }),
      },
    ]);
    expect(output.join('\n')).toContain('preview-1');
    expect(output.join('\n')).not.toContain('backend-secret');
    expect(await Bun.file(optionsFile).text()).toBe(originalOptions);
  } finally {
    await Bun.file(optionsFile)
      .exists()
      .then(async (exists) => {
        if (exists) await rm(optionsFile);
      });
  }
});

test('apply sends decisions from a local file and preserves the explicit boundary', async () => {
  const calls: Array<{ path: string; body: string | undefined }> = [];
  const decisionsFile = `${import.meta.dir}/.sync-decisions-test.json`;
  await Bun.write(decisionsFile, JSON.stringify([{ objectId: 'provider-1', choice: 'cloud' }]));
  try {
    const program = new Command();
    registerSyncCommands(program, {
      endpoint: async () => 'http://127.0.0.1:9317',
      authenticate: async () => undefined,
      request: async (path, init) => {
        calls.push({ path, body: typeof init.body === 'string' ? init.body : undefined });
        return Response.json({
          state: 'idle',
          backend: null,
          providers: [],
          pendingOperations: 0,
          lastSuccessAt: null,
        });
      },
      write: () => undefined,
    });
    await program.parseAsync(['node', 'aio-proxy', 'sync', 'apply', 'preview-1', '--decisions-file', decisionsFile]);
    expect(calls).toEqual([
      {
        path: '/dashboard/api/sync/apply',
        body: JSON.stringify({ previewId: 'preview-1', decisions: [{ objectId: 'provider-1', choice: 'cloud' }] }),
      },
    ]);
  } finally {
    await Bun.file(decisionsFile)
      .exists()
      .then(async (exists) => {
        if (exists) await rm(decisionsFile);
      });
  }
});

test('status reports an actionable message when the service is stopped', async () => {
  const program = new Command();
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => {
      throw new TypeError('connection refused');
    },
    request: async () => Response.json({}),
    write: () => undefined,
  });
  await expect(program.parseAsync(['node', 'aio-proxy', 'sync', 'status'])).rejects.toMatchObject({
    code: 'service-not-running',
    message: 'AIO Proxy is not reachable at http://127.0.0.1:9317. Start it with `aio-proxy service start`',
  });
});

test('password authentication stays in memory and is never emitted by the CLI', async () => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const emitted: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.endsWith('/dashboard/api/auth/session')) return Response.json({ status: 'unauthenticated' });
    if (url.endsWith('/dashboard/api/auth/login')) return Response.json({ token: 'memory-token' });
    return Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
  };
  const deps = createDefaultSyncCliDeps({
    fetch: fetchImpl,
    passwordStdin: true,
    readPassword: async () => {
      throw new Error('interactive prompt should not be used');
    },
    readPasswordStdin: async () => 'dashboard-secret',
    write: (value) => emitted.push(value),
  });
  const status = await createSyncClient(deps).status();
  expect(status.state).toBe('idle');
  expect(calls.find((call) => call.url.endsWith('/dashboard/api/sync'))?.body).toBeUndefined();
  expect(emitted.join('\n')).not.toContain('dashboard-secret');
});

test('preview-stale is localized without exposing a server error', async () => {
  const client = createSyncClient({
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async () => Response.json({ ok: false, error: { code: 'preview-stale' } }, { status: 409 }),
    write: () => undefined,
  });
  await expect(client.preview({ kind: 'join', providerId: 'work' })).rejects.toMatchObject({
    code: 'preview-stale',
    message: 'This preview is stale. Create and review a new preview',
  });
});

test('detach hands only the local OAuth session ID to sync control', async () => {
  const calls: Array<{ path: string; body: string | undefined }> = [];
  const output: string[] = [];
  const program = new Command();
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async (path, init) => {
      calls.push({ path, body: typeof init.body === 'string' ? init.body : undefined });
      if (path === '/dashboard/api/oauth/sessions') return Response.json({ session: { id: 'local-session' } });
      return Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
    },
    write: (value) => output.push(value),
  });
  await program.parseAsync(['node', 'aio-proxy', 'sync', 'detach', 'work', '--json']);
  expect(calls).toEqual([
    { path: '/dashboard/api/oauth/sessions', body: JSON.stringify({ targetProviderId: 'work' }) },
    {
      path: '/dashboard/api/sync/detach',
      body: JSON.stringify({ providerId: 'work', loginSessionId: 'local-session' }),
    },
  ]);
  expect(JSON.parse(output[0]!)).toMatchObject({ state: 'idle' });
});

test('JSON status is one machine-readable result', async () => {
  const output: string[] = [];
  const program = new Command();
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async () =>
      Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null }),
    write: (value) => output.push(value),
  });
  await program.parseAsync(['node', 'aio-proxy', 'sync', 'status', '--json']);
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toEqual({
    state: 'idle',
    backend: null,
    providers: [],
    pendingOperations: 0,
    lastSuccessAt: null,
  });
});

test('status delegates to one running service engine', async () => {
  const dbHome = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-sync-service-'));
  const app = await createServer({ config: { providers: {} }, dbHome, host: '127.0.0.1', port: 9317 });
  try {
    const output: string[] = [];
    const program = new Command();
    registerSyncCommands(program, {
      endpoint: async () => 'http://127.0.0.1:9317',
      authenticate: async () => undefined,
      request: async (path, init) => {
        const headers = new Headers(init.headers);
        headers.set('Host', '127.0.0.1:9317');
        headers.set('Origin', 'http://127.0.0.1:9317');
        return app.request(path, { ...init, headers }, loopbackServer);
      },
      write: (value) => output.push(value),
    });
    await program.parseAsync(['node', 'aio-proxy', 'sync', 'status', '--json']);
    expect(JSON.parse(output[0]!)).toMatchObject({ providers: [], pendingOperations: 0 });
  } finally {
    await app.closeAsync();
    rmSync(dbHome, { recursive: true, force: true });
  }
});
