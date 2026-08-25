import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { definePlugin, type OAuthAdapter, zod } from '@aio-proxy/plugin-sdk';

import { npmPackageCacheDir } from '../npm';
import type { DiagnosticFactory } from './diagnostic';
import { loadPluginRegistry } from './loader/index';

const homeEnv = 'AIO_PROXY_HOME';
const originalHome = process.env[homeEnv];
const home = mkdtempSync(`${tmpdir()}/aio-proxy-plugin-registry-`);

function install(packageName: string) {
  const packageRoot = `${npmPackageCacheDir(packageName)}/node_modules/${packageName}`;
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(`${packageRoot}/package.json`, JSON.stringify({ version: '1.0.0', main: 'index.js' }));
  writeFileSync(`${packageRoot}/index.js`, 'export default {};\n');
}

beforeAll(() => {
  process.env[homeEnv] = home;
  install('@example/broken');
  install('@example/duplicate');
});

afterAll(() => {
  if (originalHome === undefined) delete process.env[homeEnv];
  else process.env[homeEnv] = originalHome;
  rmSync(home, { recursive: true, force: true });
});

const diagnostics: DiagnosticFactory = (code, options) => ({
  code,
  retryable: options.retryable,
  summary: code,
  occurredAt: new Date(0).toISOString(),
  ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
});

function fakeAdapter(id: string, overrides: Record<string, unknown> = {}): OAuthAdapter {
  return {
    id,
    displayName: 'Example',
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error('not called');
    },
    catalog: {
      policy: { kind: 'static' },
      async discover() {
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
    async createRuntime() {
      throw new Error('not called');
    },
    ...overrides,
  } as OAuthAdapter;
}

const base = {
  builtIns: [],
  diagnostics,
  logger: () => {},
  secrets: { readPluginSecret: () => undefined },
};

describe('PluginRegistry staging', () => {
  test.each([
    ['blank adapter id', fakeAdapter(' ')],
    ['blank display name', fakeAdapter('blank-label', { displayName: ' ' })],
    ['invalid account options', fakeAdapter('account', { account: { options: { schema: {}, form: [] } } })],
    ['invalid credential schema', fakeAdapter('credentials', { credentials: {} })],
    ['missing login', fakeAdapter('login', { login: undefined })],
    ['missing catalog discover', fakeAdapter('discover', { catalog: { policy: { kind: 'static' } } })],
    ['missing runtime', fakeAdapter('runtime', { createRuntime: undefined })],
    ['non-positive ttl', fakeAdapter('ttl', { catalog: { policy: { kind: 'ttl', ttlMs: 0 }, discover() {} } })],
    ['null quota', fakeAdapter('quota-null', { quota: null })],
    ['array quota', fakeAdapter('quota-array', { quota: [] })],
    ['missing quota read', fakeAdapter('quota-read-missing', { quota: {} })],
    ['non-function quota read', fakeAdapter('quota-read-invalid', { quota: { read: 'invalid' } })],
    ['non-function quota reset', fakeAdapter('quota-reset-invalid', { quota: { read() {}, reset: 'invalid' } })],
    ['non-boolean proxy support', fakeAdapter('proxy-support-invalid', { supportsProxy: 'false' })],
    ['null credential imports', fakeAdapter('imports-null', { credentialImports: null })],
    ['array credential imports', fakeAdapter('imports-array', { credentialImports: [] })],
    [
      'missing CPA import method',
      fakeAdapter('imports-method', {
        credentialImports: { cpa: { types: ['codex'] } },
      }),
    ],
    [
      'blank CPA type',
      fakeAdapter('imports-blank', {
        credentialImports: {
          cpa: {
            types: [' '],
            async import() {
              return { fingerprint: 'x', suggestedKey: 'x', credentials: { token: 'x' } };
            },
          },
        },
      }),
    ],
    [
      'whitespace-padded CPA type',
      fakeAdapter('imports-padded', {
        credentialImports: {
          cpa: {
            types: [' codex'],
            async import() {
              return { fingerprint: 'x', suggestedKey: 'x', credentials: { token: 'x' } };
            },
          },
        },
      }),
    ],
    [
      'duplicate CPA type',
      fakeAdapter('imports-duplicate', {
        credentialImports: {
          cpa: {
            types: ['codex', 'codex'],
            async import() {
              return { fingerprint: 'x', suggestedKey: 'x', credentials: { token: 'x' } };
            },
          },
        },
      }),
    ],
  ])('rejects %s atomically', async (_name, adapter) => {
    const snapshot = await loadPluginRegistry({
      ...base,
      builtIns: [
        {
          packageName: `@example/${adapter.id || 'invalid'}`,
          version: '1.0.0',
          descriptor: definePlugin((api) => api.oauth.register(adapter)),
        },
      ],
      enablements: [{ packageName: `@example/${adapter.id || 'invalid'}` }],
      importPackage: async () => {
        throw new Error('must not import');
      },
    });
    expect(snapshot.registry.oauthCapabilities()).toHaveLength(0);
    expect(snapshot.plugins.get(`@example/${adapter.id || 'invalid'}`)?.state).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'PLUGIN_LOAD_FAILED' },
    });
  });

  test('preserves an explicit false proxy capability', async () => {
    const packageName = '@example/proxy-support';
    const snapshot = await loadPluginRegistry({
      ...base,
      builtIns: [
        {
          packageName,
          version: '1.0.0',
          descriptor: definePlugin((api) => api.oauth.register(fakeAdapter('default', { supportsProxy: false }))),
        },
      ],
      enablements: [{ packageName }],
      importPackage: async () => {
        throw new Error('must not import');
      },
    });

    expect(snapshot.registry.resolveOAuth(packageName, 'default')?.supportsProxy).toBe(false);
  });
});
