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
    label: 'Example',
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
  test('setup throw leaves no staged capabilities', async () => {
    const descriptor = definePlugin((api) => {
      api.oauth.register(fakeAdapter('first'));
      throw new Error('setup failed');
    });
    const snapshot = await loadPluginRegistry({
      ...base,
      enablements: [{ packageName: '@example/broken' }],
      importPackage: async () => ({ default: descriptor }),
    });

    expect(snapshot.registry.resolveOAuth('@example/broken', 'first')).toBeUndefined();
    expect(snapshot.plugins.get('@example/broken')?.state).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'PLUGIN_LOAD_FAILED' },
    });
  });

  test('duplicate capability rejects the whole plugin', async () => {
    const descriptor = definePlugin((api) => {
      api.oauth.register(fakeAdapter('default'));
      api.oauth.register(fakeAdapter('default'));
    });
    const snapshot = await loadPluginRegistry({
      ...base,
      enablements: [{ packageName: '@example/duplicate' }],
      importPackage: async () => ({ default: descriptor }),
    });
    expect(snapshot.registry.oauthCapabilities()).toHaveLength(0);
  });

  test('preserves class adapter, catalog, and quota method receivers', async () => {
    class Catalog {
      readonly policy = { kind: 'static' } as const;
      readonly #model = 'private-model';

      async discover() {
        return {
          language: [{ id: this.#model }],
          image: [],
          embedding: [],
          speech: [],
          transcription: [],
          reranking: [],
        };
      }
    }

    class Adapter {
      readonly id = 'class-adapter';
      readonly label = { default: 'Class adapter', 'zh-Hans': '类适配器' } as const;
      readonly account = { options: { schema: zod.object({}), form: [] } };
      readonly credentials = zod.object({ token: zod.string() });
      readonly catalog = new Catalog();
      readonly quota = new (class {
        #resetCount = 0;

        async read() {
          return { items: [{ id: 'primary', label: 'Primary', remainingRatio: this.#resetCount }] };
        }

        async reset() {
          this.#resetCount += 1;
        }
      })();
      readonly #token = 'private-token';

      async login() {
        return {
          fingerprint: 'class-account',
          suggestedKey: 'class-account',
          credentials: { token: this.#token },
        };
      }

      async createRuntime() {
        return this.#token as never;
      }
    }

    const snapshot = await loadPluginRegistry({
      ...base,
      builtIns: [
        {
          packageName: '@example/class-adapter',
          version: '1.0.0',
          descriptor: definePlugin((api) => api.oauth.register(new Adapter() as OAuthAdapter)),
        },
      ],
      enablements: [{ packageName: '@example/class-adapter' }],
      importPackage: async () => {
        throw new Error('must not import');
      },
    });
    const resolved = snapshot.registry.resolveOAuth('@example/class-adapter', 'class-adapter');
    if (resolved === undefined) throw new Error('adapter not registered');

    await expect(
      resolved.login(
        {
          authorization: {} as never,
          progress: () => {},
          signal: new AbortController().signal,
        },
        {},
      ),
    ).resolves.toMatchObject({ credentials: { token: 'private-token' } });
    await expect(resolved.catalog.discover({} as never)).resolves.toMatchObject({
      language: [{ id: 'private-model' }],
    });
    await expect(resolved.createRuntime({} as never) as unknown as Promise<string>).resolves.toBe('private-token');
    if (resolved.quota === undefined) throw new Error('quota not registered');
    await expect(resolved.quota.read({} as never)).resolves.toMatchObject({
      items: [{ remainingRatio: 0 }],
    });
    await resolved.quota.reset?.({} as never);
    await expect(resolved.quota.read({} as never)).resolves.toMatchObject({
      items: [{ remainingRatio: 1 }],
    });
  });
});
