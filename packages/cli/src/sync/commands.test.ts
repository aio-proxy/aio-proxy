import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin } from '@aio-proxy/plugin-sdk';
import { createServer } from '@aio-proxy/server';
import { Command } from 'commander';
import { z } from 'zod';

import { openDb } from '../../../core/src/db';
import { createSyncRepository } from '../../../core/src/sync/repository';
import { createMemorySyncBackend } from '../../../core/src/sync/test-support';
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

test('dashboard auth outage maps to the actionable service-unavailable error', async () => {
  const client = createSyncClient({
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async () => Response.json({ error: 'dashboard_unavailable' }, { status: 503 }),
    write: () => undefined,
  });
  await expect(client.status()).rejects.toMatchObject({ code: 'service-not-running', transient: true });
});

test('detach polls the local OAuth session until it succeeds before sync control', async () => {
  const calls: Array<{ path: string; body: string | undefined }> = [];
  const output: string[] = [];
  let polls = 0;
  const program = new Command();
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async (path, init) => {
      calls.push({ path, body: typeof init.body === 'string' ? init.body : undefined });
      if (path === '/dashboard/api/oauth/sessions')
        return Response.json({ session: { id: '11111111-1111-4111-8111-111111111111', status: 'preparing' } });
      if (path === '/dashboard/api/oauth/sessions/11111111-1111-4111-8111-111111111111') {
        polls += 1;
        return Response.json({
          session:
            polls === 1
              ? { id: '11111111-1111-4111-8111-111111111111', status: 'discovering' }
              : { id: '11111111-1111-4111-8111-111111111111', status: 'succeeded', providerId: 'work' },
        });
      }
      return Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
    },
    write: (value) => output.push(value),
  });
  await program.parseAsync(['node', 'aio-proxy', 'sync', 'detach', 'work', '--json']);
  expect(calls).toEqual([
    { path: '/dashboard/api/oauth/sessions', body: JSON.stringify({ targetProviderId: 'work' }) },
    { path: '/dashboard/api/oauth/sessions/11111111-1111-4111-8111-111111111111', body: undefined },
    { path: '/dashboard/api/oauth/sessions/11111111-1111-4111-8111-111111111111', body: undefined },
    {
      path: '/dashboard/api/sync/detach',
      body: JSON.stringify({ providerId: 'work', loginSessionId: '11111111-1111-4111-8111-111111111111' }),
    },
  ]);
  expect(JSON.parse(output[0]!)).toMatchObject({ state: 'idle' });
});

test('detach reports OAuth failure without handing a pending session to sync control', async () => {
  const calls: string[] = [];
  const program = new Command();
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async (path, _init) => {
      calls.push(path);
      if (path === '/dashboard/api/oauth/sessions')
        return Response.json({ session: { id: '22222222-2222-4222-8222-222222222222', status: 'preparing' } });
      if (path === '/dashboard/api/oauth/sessions/22222222-2222-4222-8222-222222222222')
        return Response.json({
          session: { id: '22222222-2222-4222-8222-222222222222', status: 'failed', code: 'AUTH_DENIED' },
        });
      return Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
    },
    write: () => undefined,
  });
  await expect(program.parseAsync(['node', 'aio-proxy', 'sync', 'detach', 'work', '--json'])).rejects.toMatchObject({
    code: 'oauth-login-failed',
  });
  expect(calls).toEqual([
    '/dashboard/api/oauth/sessions',
    '/dashboard/api/oauth/sessions/22222222-2222-4222-8222-222222222222',
  ]);
});

test('human previews include redacted local/cloud values and dependencies', async () => {
  const output: string[] = [];
  const program = new Command();
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async () =>
      Response.json({
        previewId: 'preview-detail',
        kind: 'join',
        rows: [
          {
            objectId: 'provider-1',
            logicalKey: 'work',
            kind: 'provider',
            change: 'conflict',
            local: { endpoint: 'local', token: '[redacted]' },
            cloud: { endpoint: 'cloud', token: '[redacted]' },
            secretChange: 'changed',
            dependencies: ['plugin-1'],
            choices: ['local', 'cloud'],
          },
        ],
        retainedSharedPlugins: [],
        expiresAt: 10,
      }),
    write: (value) => output.push(value),
  });
  await program.parseAsync(['node', 'aio-proxy', 'sync', 'join', 'work']);
  expect(output.join('\n')).toContain('"endpoint":"local"');
  expect(output.join('\n')).toContain('"endpoint":"cloud"');
  expect(output.join('\n')).toContain('plugin-1');
});

test('password stdin removes only the line ending and preserves trailing spaces', async () => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const deps = createDefaultSyncCliDeps({
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : undefined });
      if (String(input).endsWith('/dashboard/api/auth/session')) return Response.json({ status: 'unauthenticated' });
      if (String(input).endsWith('/dashboard/api/auth/login')) return Response.json({ token: 'memory-token' });
      return Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
    },
    passwordStdin: true,
    readPasswordStdin: async () => 'dashboard-secret  \n',
  });
  await createSyncClient(deps).status();
  expect(calls.find((call) => call.url.endsWith('/dashboard/api/auth/login'))?.body).toBe(
    JSON.stringify({ password: 'dashboard-secret  ' }),
  );
});

test('sync endpoint canonicalizes wildcard config hosts for requests and Origin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-sync-host-'));
  const previousHome = process.env.AIO_PROXY_HOME;
  process.env.AIO_PROXY_HOME = home;
  writeFileSync(join(home, 'config.jsonc'), '{ "server": { "host": "0.0.0.0", "port": 9317 }, "providers": {} }\n');
  const calls: Array<{ url: string; origin: string | null }> = [];
  try {
    const deps = createDefaultSyncCliDeps({
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), origin: headers.get('Origin') });
        return String(input).endsWith('/dashboard/api/auth/session')
          ? Response.json({ status: 'disabled' })
          : Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
      },
    });
    await createSyncClient(deps).status();
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:9317/dashboard/api/auth/session', origin: 'http://127.0.0.1:9317' },
      { url: 'http://127.0.0.1:9317/dashboard/api/sync', origin: 'http://127.0.0.1:9317' },
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sync refuses to send the Dashboard password in cleartext to a remote config host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-sync-remote-host-'));
  const previousHome = process.env.AIO_PROXY_HOME;
  process.env.AIO_PROXY_HOME = home;
  writeFileSync(
    join(home, 'config.jsonc'),
    '{ "server": { "host": "192.0.2.10", "port": 9317, "password": "dashboard-secret" }, "providers": {} }\n',
  );
  const calls: string[] = [];
  let promptedForPassword = false;
  try {
    const deps = createDefaultSyncCliDeps({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/dashboard/api/auth/session')) return Response.json({ status: 'unauthenticated' });
        if (url.endsWith('/dashboard/api/auth/login')) return Response.json({ token: 'memory-token' });
        return Response.json({
          state: 'idle',
          backend: null,
          providers: [],
          pendingOperations: 0,
          lastSuccessAt: null,
        });
      },
      passwordStdin: true,
      readPasswordStdin: async () => {
        promptedForPassword = true;
        return 'dashboard-secret\n';
      },
    });
    await expect(createSyncClient(deps).status()).rejects.toThrow(/192\.0\.2\.10/u);
    expect(promptedForPassword).toBe(false);
    expect(calls).toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// Over cleartext http an impostor peer can always claim the Dashboard password is disabled, so a
// refusal that only guards the password path still hands secret backend options to that peer.
test('sync refuses a remote config host that reports its Dashboard password disabled', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-sync-remote-open-'));
  const previousHome = process.env.AIO_PROXY_HOME;
  process.env.AIO_PROXY_HOME = home;
  writeFileSync(join(home, 'config.jsonc'), '{ "server": { "host": "192.0.2.10", "port": 9317 }, "providers": {} }\n');
  const calls: string[] = [];
  try {
    const deps = createDefaultSyncCliDeps({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        return url.endsWith('/dashboard/api/auth/session')
          ? Response.json({ status: 'disabled' })
          : Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
      },
    });
    await expect(
      createSyncClient(deps).preview({
        kind: 'connect',
        plugin: '@aio-proxy/plugin-cloudkit',
        capability: 'icloud',
        options: { secret: 'backend-credential' },
      }),
    ).rejects.toThrow(/192\.0\.2\.10/u);
    expect(calls).toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
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

test('configured service exposes the real sync control plane to CLI mutations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-sync-configured-'));
  const previousHome = process.env.AIO_PROXY_HOME;
  process.env.AIO_PROXY_HOME = home;
  const configPath = join(home, 'config.jsonc');
  writeFileSync(
    configPath,
    JSON.stringify({
      plugins: ['@example/sync'],
      server: { password: 'dashboard-secret' },
      providers: { work: { kind: 'api', baseUrl: 'https://local.test' } },
    }),
  );
  const db = openDb({ home });
  const repo = createSyncRepository(db.sqlite);
  repo.writeBinding({
    id: 'configured-binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'memory-identity',
    spaceId: 'default',
    deviceId: 'configured-device',
    sessionGeneration: 1,
    options: {},
  });
  repo.putEntity('configured-binding', {
    objectId: 'provider-work',
    logicalKey: 'work',
    kind: 'provider',
    mode: 'included',
    epoch: 0,
    desired: {
      kind: 'provider',
      logicalKey: 'work',
      value: { kind: 'api', baseUrl: 'https://local.test' },
      dependencies: [],
    },
    baseline: null,
    overrides: [],
    pendingReason: null,
  });
  db.close();
  const backend = createMemorySyncBackend();
  const connectedOptions: unknown[] = [];
  let mismatchOptionChecks = 0;
  const backendOptions = z
    .object({
      token: z.string().default('default-token'),
      containerId: z.string().default('default-container'),
    })
    .refine((options) => options.token !== 'mismatch' || mismatchOptionChecks++ < 2);
  const builtIns = [
    {
      packageName: '@example/sync',
      version: '1.0.0',
      descriptor: definePlugin((api) =>
        api.sync.register({
          id: 'memory',
          displayName: 'Memory',
          options: { schema: backendOptions, form: [] },
          connect: async (options, { dataDirectory }) => {
            connectedOptions.push(options);
            if (options.token.startsWith('early-failure')) {
              rmSync(dataDirectory, { recursive: true, force: true });
              writeFileSync(dataDirectory, 'blocked');
            }
            return backend.connect();
          },
        }),
      ),
    },
  ];
  const app = await createServer({
    config: {},
    configPath,
    dbHome: home,
    host: '127.0.0.1',
    port: 9317,
    builtIns,
  });
  const calls: Array<{ url: string; origin: string | null; authorization: string | null }> = [];
  try {
    expect(backend.connectionCount()).toBe(1);
    expect(backend.disposeCount()).toBe(0);
    expect(backend.activeWatchCount()).toBe(1);
    const output: string[] = [];
    const deps = createDefaultSyncCliDeps({
      fetch: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        headers.set('Host', '127.0.0.1:9317');
        calls.push({ url, origin: headers.get('Origin'), authorization: headers.get('Authorization') });
        const parsed = new URL(url);
        return app.request(parsed.pathname + parsed.search, { ...init, headers }, loopbackServer);
      },
      passwordStdin: true,
      readPasswordStdin: async () => 'dashboard-secret\n',
      write: (value) => output.push(value),
    });
    const program = new Command();
    registerSyncCommands(program, deps);
    await program.parseAsync(['node', 'aio-proxy', 'sync', 'leave', 'work', '--json']);
    expect(JSON.parse(output[0]!)).toMatchObject({
      backend: { plugin: '@example/sync', capability: 'memory' },
      providers: [{ providerId: 'work', included: false }],
    });
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/dashboard/api/auth/session',
      '/dashboard/api/auth/login',
      '/dashboard/api/sync/range',
    ]);
    expect(calls[2]).toMatchObject({ origin: 'http://127.0.0.1:9317' });
    expect(calls[2]?.authorization).toMatch(/^Bearer .+$/u);

    const optionsPath = join(home, 'sync-options.json');
    const decisionsPath = join(home, 'sync-decisions.json');
    writeFileSync(optionsPath, JSON.stringify({ token: 'backend-secret' }));
    writeFileSync(decisionsPath, '[]');
    await program.parseAsync([
      'node',
      'aio-proxy',
      'sync',
      'connect',
      '--plugin',
      '@example/sync',
      '--capability',
      'memory',
      '--options-file',
      optionsPath,
      '--json',
    ]);
    const preview = JSON.parse(output[1]!);
    expect(preview.kind).toBe('connect');
    expect(JSON.stringify(preview)).not.toContain('backend-secret');
    await program.parseAsync([
      'node',
      'aio-proxy',
      'sync',
      'apply',
      preview.previewId,
      '--decisions-file',
      decisionsPath,
      '--json',
    ]);
    expect(JSON.parse(output[2]!)).toMatchObject({
      backend: { plugin: '@example/sync', capability: 'memory' },
    });
    expect(connectedOptions).toContainEqual({ token: 'backend-secret', containerId: 'default-container' });
    expect(backend.connectionCount()).toBe(2);
    expect(backend.disposeCount()).toBe(1);
    expect(backend.activeWatchCount()).toBe(1);
    const verifyDb = openDb({ home });
    try {
      const verifyRepo = createSyncRepository(verifyDb.sqlite);
      const binding = verifyRepo.readBinding();
      expect(binding?.id).not.toBe('configured-binding');
      expect(binding?.options).toEqual({ token: 'backend-secret', containerId: 'default-container' });
      const entities = binding === null ? [] : verifyRepo.entities(binding.id);
      // The carried-over Provider keeps its object identity and its `sync leave` exclusion, and
      // every other authored object gains its own row so it can be joined later. Connecting never
      // selects anything, so all of them are excluded.
      expect(entities.map((entity) => `${entity.kind}:${entity.logicalKey}`).sort()).toEqual([
        'plugin-business:@example/sync',
        'provider:work',
        'routing-defaults:routing-defaults',
        'service-access:service-access',
      ]);
      expect(entities.filter((entity) => entity.mode === 'excluded')).toHaveLength(4);
      expect(entities.find((entity) => entity.logicalKey === 'work')?.objectId).toBe('provider-work');
    } finally {
      verifyDb.close();
    }
    await program.parseAsync(['node', 'aio-proxy', 'sync', 'status', '--json']);
    expect(JSON.parse(output[3]!)).toMatchObject({
      state: 'idle',
      backend: { plugin: '@example/sync', capability: 'memory' },
    });

    const login = await app.request(
      '/dashboard/api/auth/login',
      {
        body: JSON.stringify({ password: 'dashboard-secret' }),
        headers: { 'content-type': 'application/json', host: '127.0.0.1:9317', origin: 'http://127.0.0.1:9317' },
        method: 'POST',
      },
      loopbackServer,
    );
    const loginBody = (await login.json()) as { readonly token: string };
    const syncRequest = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Host', '127.0.0.1:9317');
      headers.set('Origin', 'http://127.0.0.1:9317');
      headers.set('Authorization', `Bearer ${loginBody.token}`);
      return app.request(path, { ...init, headers }, loopbackServer);
    };
    const concurrentInput = (token: string) =>
      JSON.stringify({ kind: 'connect', plugin: '@example/sync', capability: 'memory', options: { token } });
    const [concurrentPreviewA, concurrentPreviewB] = await Promise.all([
      syncRequest('/dashboard/api/sync/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: concurrentInput('concurrent-a'),
      }),
      syncRequest('/dashboard/api/sync/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: concurrentInput('concurrent-b'),
      }),
    ]);
    expect(concurrentPreviewA.status).toBe(200);
    expect(concurrentPreviewB.status).toBe(200);
    const concurrentPreviewBodyA = (await concurrentPreviewA.json()) as { readonly previewId: string };
    const concurrentPreviewBodyB = (await concurrentPreviewB.json()) as { readonly previewId: string };
    const [concurrentApplyA, concurrentApplyB] = await Promise.all([
      syncRequest('/dashboard/api/sync/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: concurrentPreviewBodyA.previewId, decisions: [] }),
      }),
      syncRequest('/dashboard/api/sync/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: concurrentPreviewBodyB.previewId, decisions: [] }),
      }),
    ]);
    expect(concurrentApplyA.status).toBe(200);
    expect(concurrentApplyB.status).toBe(200);
    expect(backend.connectionCount()).toBe(4);
    expect(backend.disposeCount()).toBe(3);
    expect(backend.activeWatchCount()).toBe(1);
    const concurrentDb = openDb({ home });
    try {
      const concurrentBinding = createSyncRepository(concurrentDb.sqlite).readBinding();
      expect(concurrentBinding?.id).not.toBe('configured-binding');
      expect(concurrentBinding?.options).toMatchObject({
        token: expect.stringMatching(/^concurrent-[ab]$/u),
        containerId: 'default-container',
      });
    } finally {
      concurrentDb.close();
    }

    const beforeEarlyFailureDb = openDb({ home });
    const beforeEarlyFailure = createSyncRepository(beforeEarlyFailureDb.sqlite).readBinding();
    beforeEarlyFailureDb.close();
    const beforeEarlyFailureConnections = backend.connectionCount();
    const beforeEarlyFailureDisposals = backend.disposeCount();
    rmSync(join(home, '.sync'), { recursive: true, force: true });
    mkdirSync(join(home, '.sync'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const earlyPreviewResponse = await syncRequest('/dashboard/api/sync/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: concurrentInput(`early-failure-${attempt}`),
      });
      expect(earlyPreviewResponse.status).toBe(200);
      const earlyPreview = (await earlyPreviewResponse.json()) as { readonly previewId: string };
      const earlyApplyResponse = await syncRequest('/dashboard/api/sync/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: earlyPreview.previewId, decisions: [] }),
      });
      expect(earlyApplyResponse.status).toBe(503);
    }
    expect(backend.connectionCount()).toBe(beforeEarlyFailureConnections + 2);
    expect(backend.disposeCount()).toBe(beforeEarlyFailureDisposals + 2);
    expect(backend.activeWatchCount()).toBe(1);
    const afterEarlyFailureDb = openDb({ home });
    try {
      expect(createSyncRepository(afterEarlyFailureDb.sqlite).readBinding()).toEqual(beforeEarlyFailure);
    } finally {
      afterEarlyFailureDb.close();
    }

    const beforeFailureDb = openDb({ home });
    const beforeFailure = createSyncRepository(beforeFailureDb.sqlite).readBinding();
    beforeFailureDb.close();
    expect(beforeFailure).not.toBeNull();
    const beforeFailureConnections = backend.connectionCount();
    const beforeFailureDisposals = backend.disposeCount();
    writeFileSync(optionsPath, JSON.stringify({ token: 'mismatch' }));
    await program.parseAsync([
      'node',
      'aio-proxy',
      'sync',
      'connect',
      '--plugin',
      '@example/sync',
      '--capability',
      'memory',
      '--options-file',
      optionsPath,
      '--json',
    ]);
    const failedPreview = JSON.parse(output[4]!);
    await expect(
      program.parseAsync([
        'node',
        'aio-proxy',
        'sync',
        'apply',
        failedPreview.previewId,
        '--decisions-file',
        decisionsPath,
        '--json',
      ]),
    ).rejects.toThrow();
    expect(backend.connectionCount()).toBe(beforeFailureConnections + 1);
    expect(backend.disposeCount()).toBe(beforeFailureDisposals + 1);
    expect(backend.activeWatchCount()).toBe(1);
    const afterFailureDb = openDb({ home });
    try {
      expect(createSyncRepository(afterFailureDb.sqlite).readBinding()).toEqual(beforeFailure);
    } finally {
      afterFailureDb.close();
    }
    await program.parseAsync(['node', 'aio-proxy', 'sync', 'status', '--json']);
    expect(JSON.parse(output[5]!)).toMatchObject({
      state: 'idle',
      backend: { plugin: '@example/sync', capability: 'memory' },
    });
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/dashboard/api/auth/session',
      '/dashboard/api/auth/login',
      '/dashboard/api/sync/range',
      '/dashboard/api/sync/preview',
      '/dashboard/api/sync/apply',
      '/dashboard/api/sync',
      '/dashboard/api/sync/preview',
      '/dashboard/api/sync/apply',
      '/dashboard/api/sync',
    ]);
  } finally {
    await app.closeAsync();
    if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('detach renders the device code the service reports instead of silently polling', async () => {
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const presentations: Array<{ url: string; userCode: string }> = [];
  const program = new Command();
  let polls = 0;
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async (path) => {
      if (path === '/dashboard/api/oauth/sessions')
        return Response.json({
          session: {
            id: sessionId,
            status: 'device_code',
            url: 'https://provider.example/device',
            userCode: 'WDJB-MJHT',
            instructions: 'Enter the code shown above',
          },
        });
      if (path === `/dashboard/api/oauth/sessions/${sessionId}`) {
        polls += 1;
        return Response.json({
          session:
            polls === 1
              ? { id: sessionId, status: 'device_code', url: 'https://provider.example/device', userCode: 'WDJB-MJHT' }
              : { id: sessionId, status: 'succeeded', providerId: 'work' },
        });
      }
      return Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
    },
    write: () => undefined,
    authorization: {
      presentDeviceCode: async (presentation) => {
        presentations.push({ url: presentation.url, userCode: presentation.userCode });
      },
      presentAuthorizeUrl: async () => undefined,
    },
  });
  await program.parseAsync(['node', 'aio-proxy', 'sync', 'detach', 'work', '--json']);
  // Rendered once when the state is entered, not repeated for every poll.
  expect(presentations).toEqual([{ url: 'https://provider.example/device', userCode: 'WDJB-MJHT' }]);
});

test('detach submits a manual callback URL for a loopback session', async () => {
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const callbackPath = `/dashboard/api/oauth/sessions/${sessionId}/callback`;
  const authorizeUrls: string[] = [];
  const program = new Command();
  let submitted: string | undefined;
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async (path, init) => {
      const loopback = {
        id: sessionId,
        status: 'loopback',
        authorizationUrl: 'https://provider.example/authorize?state=abc',
        allowManualCallback: true,
      };
      if (path === '/dashboard/api/oauth/sessions') return Response.json({ session: loopback });
      if (path === callbackPath) {
        submitted = typeof init.body === 'string' ? (JSON.parse(init.body) as { callbackUrl: string }).callbackUrl : '';
        return Response.json({ session: { id: sessionId, status: 'discovering' } });
      }
      if (path === `/dashboard/api/oauth/sessions/${sessionId}`)
        return Response.json({
          session: submitted === undefined ? loopback : { id: sessionId, status: 'succeeded', providerId: 'work' },
        });
      return Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
    },
    write: () => undefined,
    authorization: {
      presentDeviceCode: async () => undefined,
      presentAuthorizeUrl: async (presentation) => {
        authorizeUrls.push(presentation.url);
      },
    },
    readManualCallbackUrl: async () => 'http://127.0.0.1:7788/callback?code=granted&state=abc',
  });
  await program.parseAsync(['node', 'aio-proxy', 'sync', 'detach', 'work', '--json']);
  expect(authorizeUrls).toEqual(['https://provider.example/authorize?state=abc']);
  expect(submitted).toBe('http://127.0.0.1:7788/callback?code=granted&state=abc');
});

test('sync mutations carry their own deadline while reads keep the default request timeout', async () => {
  const signals = new Map<string, boolean>();
  const client = createSyncClient({
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async (path, init) => {
      signals.set(path, init.signal !== undefined);
      return Response.json({ state: 'idle', backend: null, providers: [], pendingOperations: 0, lastSuccessAt: null });
    },
    write: () => undefined,
  });
  await client.status();
  await client.retry();
  await client.apply({ previewId: 'preview-1', decisions: [] });
  expect(signals.get('/dashboard/api/sync')).toBe(false);
  expect(signals.get('/dashboard/api/sync/retry')).toBe(true);
  expect(signals.get('/dashboard/api/sync/apply')).toBe(true);
});
