import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { definePlugin, type OAuthAdapter, type OAuthCredentialImportContext, zod } from '@aio-proxy/plugin-sdk';

import { npmPackageCacheDir } from '../npm';
import type { DiagnosticFactory } from './diagnostic';
import { loadPluginRegistry } from './loader/index';
import {
  createPluginRegistryHost,
  type BuiltInPluginApi,
  type ResponsesPreRouteWrap,
  type ResponsesRawWrap,
} from './registry';

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
  test('registers an adapter with localSignIn and keeps its methods bound', async () => {
    class LocalSignIn {
      readonly source = { default: 'Example tool', 'zh-Hans': '示例工具' };
      readonly calls: string[] = [];
      #token = 'previous-token';

      async detect(context: { readonly signal: AbortSignal }) {
        context.signal.throwIfAborted();
        this.calls.push('detect');
        return this.#token !== '';
      }

      async read(context: OAuthCredentialImportContext, options: { readonly accountId: string }) {
        context.signal.throwIfAborted();
        this.calls.push('read');
        context.progress('Reading example sign-in');
        return {
          fingerprint: options.accountId,
          suggestedKey: options.accountId,
          credentials: { token: this.#token },
        };
      }

      async write(
        _context: { readonly signal: AbortSignal },
        next: { readonly token: string },
        previous: { readonly token: string },
      ) {
        this.calls.push('write');
        if (this.#token === previous.token) this.#token = next.token;
      }
    }

    const localSignIn = new LocalSignIn();
    const host = createPluginRegistryHost();
    const staging = host.stage('@example/local-sign-in');
    staging.api.oauth.register(fakeAdapter('default', { localSignIn }));
    staging.seal();
    staging.commit();

    expect(localSignIn.calls).toEqual([]);
    const resolved = host.registry.resolveOAuth('@example/local-sign-in', 'default')?.localSignIn;
    expect(resolved).toBeDefined();
    if (resolved === undefined) throw new Error('local sign-in not registered');
    expect(resolved.source).toEqual(localSignIn.source);
    const { detect, read, write } = resolved;
    const signal = new AbortController().signal;
    const progress: string[] = [];
    const context = { signal, progress: (message: unknown) => progress.push(String(message)) };
    const options = { accountId: 'example-account' };
    await expect(detect({ signal })).resolves.toBe(true);
    await expect(read(context, options)).resolves.toEqual({
      fingerprint: 'example-account',
      suggestedKey: 'example-account',
      credentials: { token: 'previous-token' },
    });
    expect(write).toBeDefined();
    if (write === undefined) throw new Error('local sign-in write not registered');
    await write({ signal }, { token: 'next-token' }, { token: 'previous-token' });
    await expect(read(context, options)).resolves.toMatchObject({ credentials: { token: 'next-token' } });
    expect(localSignIn.calls).toEqual(['detect', 'read', 'write', 'read']);
    expect(progress).toEqual(['Reading example sign-in', 'Reading example sign-in']);
  });

  test('registers a read-only local sign-in without adding write', async () => {
    const localSignIn = {
      source: 'Example tool',
      async detect() {
        return true;
      },
      async read() {
        return { fingerprint: 'example', suggestedKey: 'example', credentials: { token: 'example-token' } };
      },
    };
    const host = createPluginRegistryHost();
    const staging = host.stage('@example/read-only-local-sign-in');
    staging.api.oauth.register(fakeAdapter('default', { localSignIn }));
    staging.seal();
    staging.commit();

    const resolved = host.registry.resolveOAuth('@example/read-only-local-sign-in', 'default')?.localSignIn;
    expect(resolved).toBeDefined();
    if (resolved === undefined) throw new Error('local sign-in not registered');
    expect(resolved.source).toBe('Example tool');
    expect(resolved).not.toHaveProperty('write');
    await expect(
      resolved.read({ signal: new AbortController().signal, progress: () => {} }, {}),
    ).resolves.toMatchObject({
      credentials: { token: 'example-token' },
    });
  });

  const validLocalSignIn = {
    source: 'Example tool',
    detect: async () => true,
    read: async () => ({ fingerprint: 'example', suggestedKey: 'example', credentials: {} }),
  };
  test.each([
    ['null', null],
    ['array', []],
    ['primitive', true],
    ['missing detect', { source: validLocalSignIn.source, read: validLocalSignIn.read }],
    ['missing read', { source: validLocalSignIn.source, detect: validLocalSignIn.detect }],
    ['non-function detect', { ...validLocalSignIn, detect: true }],
    ['non-function read', { ...validLocalSignIn, read: true }],
    ['non-function write', { ...validLocalSignIn, write: true }],
    ['missing source', { detect: validLocalSignIn.detect, read: validLocalSignIn.read }],
    ['empty source', { ...validLocalSignIn, source: '' }],
    ['padded source', { ...validLocalSignIn, source: ' Example tool ' }],
    ['source without default', { ...validLocalSignIn, source: { 'zh-Hans': '示例工具' } }],
    ['invalid source translation', { ...validLocalSignIn, source: { default: 'Example tool', 'zh-Hans': 1 } }],
  ])('rejects invalid localSignIn: %s', (_reason, localSignIn) => {
    const host = createPluginRegistryHost();
    const staging = host.stage('@example/invalid-local-sign-in');
    expect(() => staging.api.oauth.register(fakeAdapter('default', { localSignIn }))).toThrow(
      new Error('Invalid OAuth adapter'),
    );
    staging.seal();
    staging.commit();
    expect(host.registry.oauthCapabilities()).toHaveLength(0);
  });

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

  test('rejects duplicate responses pre-route registration', () => {
    const host = createPluginRegistryHost();
    const staging = host.stage('@aio-proxy/plugin-openai-chatgpt', { builtIn: true });
    const preRoute: ResponsesPreRouteWrap = () => async () => undefined;

    staging.api.raw.register('openai-response', 'pre-route', preRoute);
    expect(() => staging.api.raw.register('openai-response', 'pre-route', preRoute)).toThrow(
      'Duplicate responses pre-route hook',
    );
  });

  test('failed built-in setup commits neither responses capability', async () => {
    const descriptor = definePlugin((api) => {
      const builtInApi = api as BuiltInPluginApi;
      const raw: ResponsesRawWrap = ({ original }) => original;
      const preRoute: ResponsesPreRouteWrap = () => async () => undefined;
      builtInApi.raw.register('openai-response', 'wrap', raw);
      builtInApi.raw.register('openai-response', 'pre-route', preRoute);
      throw new Error('setup failed');
    });
    const snapshot = await loadPluginRegistry({
      ...base,
      builtIns: [
        {
          packageName: '@example/broken-built-in',
          version: '1.0.0',
          descriptor,
        },
      ],
      enablements: [{ packageName: '@example/broken-built-in' }],
      importPackage: async () => {
        throw new Error('must not import');
      },
    });

    expect(snapshot.registry.resolveResponses('@example/broken-built-in')).toBeUndefined();
    expect(snapshot.plugins.get('@example/broken-built-in')?.state).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'PLUGIN_LOAD_FAILED' },
    });
  });

  test('duplicate CPA type rejects the whole second plugin', async () => {
    const importer = {
      types: ['codex'],
      async import() {
        return { fingerprint: 'x', suggestedKey: 'x', credentials: { token: 'x' } };
      },
    };
    const snapshot = await loadPluginRegistry({
      ...base,
      builtIns: [
        {
          packageName: '@example/cpa-first',
          version: '1.0.0',
          descriptor: definePlugin((api) =>
            api.oauth.register(fakeAdapter('first', { credentialImports: { cpa: importer } })),
          ),
        },
        {
          packageName: '@example/cpa-second',
          version: '1.0.0',
          descriptor: definePlugin((api) => {
            api.oauth.register(fakeAdapter('unrelated'));
            api.oauth.register(fakeAdapter('second', { credentialImports: { cpa: importer } }));
          }),
        },
      ],
      enablements: [{ packageName: '@example/cpa-first' }, { packageName: '@example/cpa-second' }],
      importPackage: async () => {
        throw new Error('must not import');
      },
    });

    expect(snapshot.registry.resolveOAuth('@example/cpa-first', 'first')).toBeDefined();
    expect(snapshot.registry.resolveOAuth('@example/cpa-second', 'unrelated')).toBeUndefined();
    expect(snapshot.registry.resolveOAuth('@example/cpa-second', 'second')).toBeUndefined();
    expect(snapshot.plugins.get('@example/cpa-second')?.state).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'PLUGIN_LOAD_FAILED' },
    });
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
      readonly displayName = { default: 'Class adapter', 'zh-Hans': '类适配器' } as const;
      readonly account = { options: { schema: zod.object({}), form: [] } };
      readonly credentials = zod.object({ token: zod.string() });
      readonly catalog = new Catalog();
      readonly quota = new (class {
        #resetCount = 0;

        async read() {
          return { items: [{ id: 'primary', displayName: 'Primary', remainingRatio: this.#resetCount }] };
        }

        async reset() {
          this.#resetCount += 1;
        }
      })();
      readonly #token = 'private-token';
      readonly credentialImports = {
        cpa: new (class {
          readonly types = ['class-auth'] as const;
          readonly #token = 'private-import-token';

          async import() {
            return {
              fingerprint: 'class-import',
              suggestedKey: 'class-import',
              credentials: { token: this.#token },
            };
          }
        })(),
      };

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
    await expect(
      resolved.credentialImports?.cpa?.import({ progress: () => {}, signal: new AbortController().signal }, {}, {}),
    ).resolves.toMatchObject({ credentials: { token: 'private-import-token' } });
  });
});
