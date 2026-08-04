/* oxlint-disable eslint/max-lines, eslint/max-lines-per-function -- one cohesive lifecycle fixture exercises cross-operation races */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicConfigFile,
  createPluginRepository,
  npmPackageCacheDir,
  parseRuntimeConfig,
  Router,
  type PluginPackageImporter,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, type PluginDescriptor } from '@aio-proxy/plugin-sdk';
import { z } from 'zod';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createPluginControlPlaneAccess } from '../../plugin-control-plane/access';
import { candidateOptions } from '../../plugin-control-plane/plugin-config';
import { createServerState, type ServerState } from '../../server-state';
import type { ServerStateTestHooks } from '../../server-state/types';
import { createDashboardRoutes } from '../config';

const builtInPackage = '@example/builtin-plugin';
const configurablePackage = '@scope/secret-plugin';

const emptyDescriptor = () => definePlugin(() => {});
const configurableDescriptor = () =>
  definePlugin(() => {}, {
    options: {
      schema: z.object({ endpoint: z.url(), token: z.string().min(1).optional() }),
      form: [
        { type: 'text', key: 'endpoint', label: 'Endpoint' },
        { type: 'secret', key: 'token', label: 'Token' },
      ],
    },
  });

const oauthRaceDescriptor = (deviceCodePresented: () => void, loginReleased: Promise<void>) =>
  definePlugin(
    (api) => {
      api.oauth.register({
        id: 'default',
        label: 'Example OAuth',
        account: { options: { schema: z.object({}), form: [] } },
        credentials: z.object({ token: z.string() }),
        async login({ authorization }) {
          await authorization.presentDeviceCode({
            url: 'https://example.test/device',
            userCode: 'ABCD-EFGH',
          });
          deviceCodePresented();
          await loginReleased;
          return { fingerprint: 'person@example.test', suggestedKey: 'person', credentials: { token: 'secret' } };
        },
        catalog: {
          policy: { kind: 'static' },
          async discover() {
            return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
          },
        },
        async createRuntime() {
          return { models: {} };
        },
      });
    },
    {
      options: {
        schema: z.object({ endpoint: z.url(), token: z.string().optional() }),
        form: [
          { type: 'text', key: 'endpoint', label: 'Endpoint' },
          { type: 'secret', key: 'token', label: 'Token' },
        ],
      },
    },
  );

type Fixture = {
  readonly configPath: string;
  readonly repository: ReturnType<typeof createPluginRepository>;
  readonly routes: ReturnType<typeof createDashboardRoutes>;
  readonly state: ServerState;
};

const homes: string[] = [];
const previousHome = process.env['AIO_PROXY_HOME'];

function writeCachedPackage(packageName: string, version = '1.0.0'): string {
  const packageDirectory = join(npmPackageCacheDir(packageName), 'node_modules', ...packageName.split('/'));
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: packageName, version, main: 'index.js' }),
  );
  const entrypoint = join(packageDirectory, 'index.js');
  writeFileSync(entrypoint, 'export default {}\n');
  return entrypoint;
}

function updateOptions(
  routes: ReturnType<typeof createDashboardRoutes>,
  body: Record<string, unknown>,
): Promise<Response> {
  return routes.request('/plugins/options', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'PUT',
  });
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    readonly config?: Record<string, unknown>;
    readonly descriptors?: ReadonlyMap<string, PluginDescriptor<unknown>>;
    readonly prepare?: (repository: Fixture['repository']) => void;
    readonly configPath?: boolean;
    readonly testHooks?: ServerStateTestHooks;
    readonly providerInstances?: [];
  } = {},
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'aio-dashboard-plugins-'));
  homes.push(home);
  process.env['AIO_PROXY_HOME'] = home;
  const configPath = join(home, 'config.json');
  const config = options.config ?? {
    plugins: [builtInPackage, [configurablePackage, { endpoint: 'https://public.example' }]],
    providers: {},
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeCachedPackage(configurablePackage, '2.0.0');
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  options.prepare?.(repository);
  const descriptors =
    options.descriptors ??
    new Map<string, PluginDescriptor<unknown>>([[configurablePackage, configurableDescriptor()]]);
  const importPlugin: PluginPackageImporter = async ({ packageName }) => ({ default: descriptors.get(packageName) });
  const state = await createServerState({
    builtIns: [{ packageName: builtInPackage, version: 'built-in', descriptor: emptyDescriptor() }],
    config: parseRuntimeConfig(config),
    ...(options.configPath === false ? {} : { configPath }),
    dbHome: home,
    importPlugin,
    pluginRepository: repository,
    ...(options.providerInstances === undefined ? {} : { providerInstances: options.providerInstances }),
    watchConfig: false,
    ...(options.testHooks === undefined ? {} : ({ __test: options.testHooks } as never)),
  });
  try {
    await run({
      configPath,
      repository,
      routes: createDashboardRoutes(state, disabledDashboardAuthentication),
      state,
    });
  } finally {
    state.close();
    handle.close();
  }
}

function installPlugin(
  routes: ReturnType<typeof createDashboardRoutes>,
  body: Record<string, unknown>,
): Promise<Response> {
  return routes.request('/plugins/install', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

function uninstallPlugin(
  routes: ReturnType<typeof createDashboardRoutes>,
  body: Record<string, unknown>,
): Promise<Response> {
  return routes.request('/plugins/uninstall', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'DELETE',
  });
}

async function waitForProvider(configPath: string, providerId: string): Promise<unknown> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const config = JSON.parse(await Bun.file(configPath).text()) as { providers?: Record<string, unknown> };
    if (config.providers?.[providerId] !== undefined) return config.providers[providerId];
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for Provider ${providerId}`);
}

type OAuthSessionSnapshot = { readonly status: string; readonly code?: string; readonly providerId?: string };

async function waitForOAuthSession(
  routes: ReturnType<typeof createDashboardRoutes>,
  sessionId: string,
  accept: (session: OAuthSessionSnapshot) => boolean,
): Promise<OAuthSessionSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await routes.request(`/oauth/sessions/${sessionId}`);
    const { session } = (await response.json()) as { session: OAuthSessionSnapshot };
    if (accept(session)) return session;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for OAuth session ${sessionId}`);
}

function serializedLifecycle(): NonNullable<
  NonNullable<ServerStateTestHooks['pluginControlPlane']>['withNpmPackageLifecycle']
> {
  let tail = Promise.resolve();
  return async (_packageName, use) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await use(async () => {});
    } finally {
      release();
    }
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
  if (previousHome === undefined) delete process.env['AIO_PROXY_HOME'];
  else process.env['AIO_PROXY_HOME'] = previousHome;
});

describe.serial('Dashboard plugin control plane', () => {
  test('plugin option mutation preserves __proto__ as an own secret field', () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: z.object({ ['__proto__']: z.string() }),
        form: [{ type: 'secret', key: '__proto__', label: 'Token' }],
      },
    });
    const candidate = candidateOptions(
      descriptor,
      {
        packageName: '@scope/proto-plugin',
        revision: 'irrelevant',
        publicValues: {},
        secretValues: JSON.parse('{"__proto__":"secret"}') as Record<string, unknown>,
        clearSecretKeys: [],
      },
      {},
    );

    expect(Object.hasOwn(candidate.secrets, '__proto__')).toBe(true);
    expect(candidate.secrets['__proto__']).toBe('secret');
  });

  test('descriptor access maps only package classification failures', async () => {
    const callbackError = new Error('callback failure');
    let imported: unknown = { default: emptyDescriptor() };
    const access = createPluginControlPlaneAccess({
      acquireSnapshot: () => {
        throw new Error('unused');
      },
      builtIns: [],
      findInstalledNpmPackage: async () => ({ entrypoint: '/tmp/plugin/index.js', version: '1.0.0' }),
      importPackage: async () => imported,
      withNpmPackageLifecycle: async (_packageName, use) => use(async () => {}),
    });

    await expect(
      access.withDescriptor('@scope/callback-plugin', async () => Promise.reject(callbackError)),
    ).rejects.toBe(callbackError);

    imported = {};
    await expect(access.withDescriptor('@scope/invalid-plugin', async () => {})).rejects.toMatchObject({
      code: 'descriptor_invalid',
    });
  });

  test('GET /plugins returns typed summaries without descriptor, config, or secret data', async () => {
    await withFixture(
      async ({ routes }) => {
        const response = await routes.request('/plugins');
        const text = await response.text();

        expect(response.status).toBe(200);
        expect(JSON.parse(text)).toEqual({
          plugins: [
            {
              builtin: true,
              enabled: true,
              hasOptions: false,
              packageName: builtInPackage,
              state: { status: 'ready' },
              version: 'built-in',
            },
            {
              builtin: false,
              enabled: true,
              hasOptions: true,
              packageName: configurablePackage,
              state: { status: 'ready' },
              version: '2.0.0',
            },
          ],
        });
        expect(text).not.toMatch(/public\.example|super-secret-token|metadata|setup/u);
      },
      {
        prepare: (repository) => {
          repository.writePluginSecret(configurablePackage, null, { token: 'super-secret-token' });
        },
      },
    );
  });

  test('GET /plugins/edit-view exposes only public values, configured-secret flags, and an opaque revision', async () => {
    await withFixture(
      async ({ routes }) => {
        const response = await routes.request(
          `/plugins/edit-view?packageName=${encodeURIComponent(configurablePackage)}`,
        );
        const text = await response.text();
        const body = JSON.parse(text) as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          packageName: configurablePackage,
          publicValues: { endpoint: 'https://public.example' },
          form: [
            { type: 'text', key: 'endpoint', label: 'Endpoint' },
            { type: 'secret', key: 'token', label: 'Token', configured: true },
          ],
        });
        expect(body['revision']).toMatch(/^sha256:[a-f0-9]{64}$/u);
        expect(text).not.toMatch(/super-secret-token|"token":"/u);

        const ambiguousPath = await routes.request('/plugins/@scope/secret-plugin');
        expect(ambiguousPath.status).toBe(404);
      },
      {
        prepare: (repository) => {
          repository.writePluginSecret(configurablePackage, null, { token: 'super-secret-token' });
        },
      },
    );
  });

  test('templated plugin enablements are found without losing their authored package reference', async () => {
    const variable = 'DASHBOARD_PLUGIN_PACKAGE';
    const authoredPackage = `{{env.${variable}}}`;
    const previous = process.env[variable];
    let installs = 0;
    process.env[variable] = configurablePackage;
    try {
      await withFixture(
        async ({ configPath, repository, routes }) => {
          const install = await installPlugin(routes, { packageName: configurablePackage, confirmed: true });
          expect(install.status).toBe(409);
          expect(await install.json()).toEqual({ ok: false, error: { code: 'already_installed' } });
          expect(installs).toBe(0);

          const current = (await (
            await routes.request(`/plugins/edit-view?packageName=${encodeURIComponent(configurablePackage)}`)
          ).json()) as { publicValues: unknown; revision: string };
          expect(current.publicValues).toEqual({ endpoint: 'https://public.example' });

          const updated = await updateOptions(routes, {
            packageName: configurablePackage,
            revision: current.revision,
            publicValues: { endpoint: 'https://changed.example' },
            secretValues: {},
            clearSecretKeys: [],
          });
          expect(updated.status).toBe(200);
          expect(repository.readPluginSecret(configurablePackage)?.value).toEqual({ token: 'original-secret' });
          expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([
            [authoredPackage, { endpoint: 'https://changed.example' }],
          ]);

          const removed = await uninstallPlugin(routes, { packageName: configurablePackage });
          expect(removed.status).toBe(200);
          expect(repository.readPluginSecret(configurablePackage)).toBeNull();
          expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([]);
        },
        {
          config: {
            plugins: [[authoredPackage, { endpoint: 'https://public.example' }]],
            providers: {},
          },
          prepare: (repository) => {
            repository.writePluginSecret(configurablePackage, null, { token: 'original-secret' });
          },
          testHooks: {
            pluginControlPlane: {
              withInstalledNpmPackage: async () => {
                installs += 1;
                throw new Error('install should not run');
              },
            },
          },
        },
      );
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  test('PUT /plugins/options replaces public values, preserves omitted secrets, and clears only explicit secrets', async () => {
    await withFixture(
      async ({ configPath, repository, routes }) => {
        const before = (await (
          await routes.request(`/plugins/edit-view?packageName=${encodeURIComponent(configurablePackage)}`)
        ).json()) as { revision: string };
        const preserved = await updateOptions(routes, {
          packageName: configurablePackage,
          revision: before.revision,
          publicValues: { endpoint: 'https://changed.example' },
          secretValues: {},
          clearSecretKeys: [],
        });
        const preservedBody = (await preserved.json()) as {
          ok: boolean;
          plugin: { revision: string };
        };

        expect(preserved.status).toBe(200);
        expect(preservedBody.ok).toBe(true);
        expect(repository.readPluginSecret(configurablePackage)?.value).toEqual({ token: 'super-secret-token' });
        expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([
          builtInPackage,
          [configurablePackage, { endpoint: 'https://changed.example' }],
        ]);

        const cleared = await updateOptions(routes, {
          packageName: configurablePackage,
          revision: preservedBody.plugin.revision,
          publicValues: { endpoint: 'https://changed.example' },
          secretValues: {},
          clearSecretKeys: ['token'],
        });

        expect(cleared.status).toBe(200);
        expect(await cleared.json()).toMatchObject({
          ok: true,
          plugin: { form: [{ type: 'text' }, { type: 'secret', key: 'token', configured: false }] },
        });
        expect(repository.readPluginSecret(configurablePackage)?.value).toEqual({});
      },
      {
        prepare: (repository) => {
          repository.writePluginSecret(configurablePackage, null, { token: 'super-secret-token' });
        },
      },
    );
  });

  test('PUT /plugins/options isolates descriptor setup mutations from committed public and secret values', async () => {
    const packageName = configurablePackage;
    const sentinel = 'dashboard-setup-secret-sentinel';
    const setupMutation = 'dashboard-setup-mutated-secret';
    let setupCompleted = false;
    const descriptors = new Map<string, PluginDescriptor<unknown>>([[packageName, configurableDescriptor()]]);
    const descriptor = definePlugin(
      (_api, value) => {
        const options = value as {
          settings: { nested: { value: string } } | string;
          token: { value: string };
        };
        if (typeof options.settings === 'string' || options.settings.nested.value !== 'safe-public') return;
        const capturedSecret = options.token.value;
        options.settings.nested.value = capturedSecret;
        Object.defineProperty(options.settings, 'toJSON', { value: () => capturedSecret });
        options.token.value = setupMutation;
        setupCompleted = true;
      },
      {
        options: {
          schema: {
            safeParse() {},
            async safeParseAsync(value: unknown) {
              const options = value as {
                settings: { nested: { value: string } } | string;
                token: string | { value: string };
              };
              return {
                success: true,
                data: {
                  settings: options.settings,
                  token: typeof options.token === 'string' ? { value: options.token } : options.token,
                },
              };
            },
          } as never,
          form: [
            { type: 'json', key: 'settings', label: 'Settings' },
            { type: 'secret', key: 'token', label: 'Token' },
          ],
        },
      },
    );
    await withFixture(
      async ({ configPath, repository, routes }) => {
        descriptors.set(packageName, descriptor);
        const originalSecret = repository.readPluginSecret(packageName)!;
        repository.writePluginSecret(packageName, originalSecret.revision, { token: { value: sentinel } });
        const current = (await (
          await routes.request(`/plugins/edit-view?packageName=${encodeURIComponent(packageName)}`)
        ).json()) as { revision: string };
        const response = await updateOptions(routes, {
          packageName,
          revision: current.revision,
          publicValues: { settings: { nested: { value: 'safe-public' } } },
          secretValues: {},
          clearSecretKeys: [],
        });
        const responseText = await response.text();
        const configText = await Bun.file(configPath).text();

        expect(response.status).toBe(200);
        expect(setupCompleted).toBe(true);
        expect(responseText).not.toContain(sentinel);
        expect(responseText).not.toContain(setupMutation);
        expect(configText).not.toContain(sentinel);
        expect(configText).not.toContain(setupMutation);
        expect(JSON.parse(configText).plugins).toEqual([
          [packageName, { settings: { nested: { value: 'safe-public' } } }],
        ]);
        expect(repository.readPluginSecret(packageName)?.value).toEqual({ token: { value: sentinel } });
      },
      {
        config: {
          plugins: [[packageName, { endpoint: 'https://public.example' }]],
          providers: {},
        },
        descriptors,
        prepare: (repository) => {
          repository.writePluginSecret(packageName, null, { token: sentinel });
        },
      },
    );
  });

  test('PUT /plugins/options rejects unknown fields and stale revisions without changing the winner', async () => {
    await withFixture(
      async ({ configPath, repository, routes }) => {
        const current = (await (
          await routes.request(`/plugins/edit-view?packageName=${encodeURIComponent(configurablePackage)}`)
        ).json()) as { revision: string };
        const unknown = await updateOptions(routes, {
          packageName: configurablePackage,
          revision: current.revision,
          publicValues: { endpoint: 'https://public.example', unexpected: true },
          secretValues: {},
          clearSecretKeys: [],
        });
        expect(unknown.status).toBe(422);
        expect(await unknown.json()).toEqual({ ok: false, error: { code: 'options_invalid' } });

        const winner = await updateOptions(routes, {
          packageName: configurablePackage,
          revision: current.revision,
          publicValues: { endpoint: 'https://winner.example' },
          secretValues: { token: 'winner-secret' },
          clearSecretKeys: [],
        });
        expect(winner.status).toBe(200);

        const stale = await updateOptions(routes, {
          packageName: configurablePackage,
          revision: current.revision,
          publicValues: { endpoint: 'https://loser.example' },
          secretValues: { token: 'loser-secret' },
          clearSecretKeys: [],
        });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({ ok: false, error: { code: 'stale_revision' } });
        expect(repository.readPluginSecret(configurablePackage)?.value).toEqual({ token: 'winner-secret' });
        expect(JSON.parse(await Bun.file(configPath).text()).plugins).toContainEqual([
          configurablePackage,
          { endpoint: 'https://winner.example' },
        ]);
      },
      {
        prepare: (repository) => {
          repository.writePluginSecret(configurablePackage, null, { token: 'original-secret' });
        },
      },
    );
  });

  test('PUT /plugins/options reports a secret CAS race as a stale revision', async () => {
    await withFixture(
      async ({ repository, routes }) => {
        const current = (await (
          await routes.request(`/plugins/edit-view?packageName=${encodeURIComponent(configurablePackage)}`)
        ).json()) as { revision: string };
        const response = await updateOptions(routes, {
          packageName: configurablePackage,
          revision: current.revision,
          publicValues: { endpoint: 'https://loser.example' },
          secretValues: { token: 'loser-secret' },
          clearSecretKeys: [],
        });

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ ok: false, error: { code: 'stale_revision' } });
        expect(repository.readPluginSecret(configurablePackage)?.value).toEqual({ token: 'winner-secret' });
      },
      {
        prepare: (repository) => {
          repository.writePluginSecret(configurablePackage, null, { token: 'original-secret' });
          const writeSecret = repository.writePluginSecret.bind(repository);
          let raced = false;
          Object.defineProperty(repository, 'writePluginSecret', {
            value: (packageName: string, expectedRevision: number | null, value: unknown) => {
              if (!raced && packageName === configurablePackage) {
                raced = true;
                writeSecret(packageName, expectedRevision, { token: 'winner-secret' });
              }
              return writeSecret(packageName, expectedRevision, value);
            },
          });
        },
      },
    );
  });

  test('POST /plugins/install requires confirmation and validates configPath before npm installation', async () => {
    let installs = 0;
    const packageName = '@scope/new-plugin';
    const withInstalledNpmPackage: NonNullable<
      NonNullable<ServerStateTestHooks['pluginControlPlane']>['withInstalledNpmPackage']
    > = async (candidate, _registry, use) => {
      installs += 1;
      return use({ entrypoint: writeCachedPackage(candidate), version: '1.0.0' }, async () => {});
    };
    await withFixture(
      async ({ routes }) => {
        const unconfirmed = await installPlugin(routes, { packageName, confirmed: false });
        expect(unconfirmed.status).toBe(400);
        expect(await unconfirmed.json()).toEqual({
          ok: false,
          error: { code: 'confirmation_required' },
        });
        expect(installs).toBe(0);
      },
      {
        config: { plugins: [], providers: {} },
        descriptors: new Map([[packageName, emptyDescriptor()]]),
        testHooks: { pluginControlPlane: { withInstalledNpmPackage } },
      },
    );
    await withFixture(
      async ({ routes }) => {
        const unavailable = await installPlugin(routes, { packageName, confirmed: true });
        expect(unavailable.status).toBe(409);
        expect(await unavailable.json()).toEqual({ ok: false, error: { code: 'config_unavailable' } });
        expect(installs).toBe(0);
      },
      {
        config: { plugins: [], providers: {} },
        configPath: false,
        descriptors: new Map([[packageName, emptyDescriptor()]]),
        testHooks: { pluginControlPlane: { withInstalledNpmPackage } },
      },
    );
  });

  test('POST /plugins/install rejects invalid descriptors, required options, and setup failures without enablement', async () => {
    const invalid = '@scope/invalid-plugin';
    const required = '@scope/required-plugin';
    const brokenSetup = '@scope/broken-setup-plugin';
    const descriptors = new Map<string, PluginDescriptor<unknown>>([
      [
        required,
        definePlugin(() => {}, {
          options: {
            schema: z.object({ token: z.string().min(1) }),
            form: [{ type: 'secret', key: 'token', label: 'Token' }],
          },
        }),
      ],
      [
        brokenSetup,
        definePlugin(() => {
          throw new Error('setup-secret-must-not-leak');
        }),
      ],
    ]);
    const withInstalledNpmPackage: NonNullable<
      NonNullable<ServerStateTestHooks['pluginControlPlane']>['withInstalledNpmPackage']
    > = async (packageName, _registry, use) =>
      use({ entrypoint: writeCachedPackage(packageName), version: '1.0.0' }, async () => {});
    await withFixture(
      async ({ configPath, routes }) => {
        for (const [packageName, code] of [
          [invalid, 'descriptor_invalid'],
          [required, 'options_invalid'],
          [brokenSetup, 'setup_failed'],
        ] as const) {
          const response = await installPlugin(routes, { packageName, confirmed: true });
          const text = await response.text();

          expect(response.status).toBe(422);
          expect(JSON.parse(text)).toEqual({ ok: false, error: { code } });
          expect(text).not.toContain('setup-secret-must-not-leak');
          expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([]);
        }
      },
      {
        config: { plugins: [], providers: {} },
        descriptors,
        testHooks: { pluginControlPlane: { withInstalledNpmPackage } },
      },
    );
  });

  test('POST /plugins/install rolls back enablement when runtime reload rejects the plugin', async () => {
    const packageName = '@scope/reload-failure-plugin';
    let rejectReload = false;
    const withInstalledNpmPackage: NonNullable<
      NonNullable<ServerStateTestHooks['pluginControlPlane']>['withInstalledNpmPackage']
    > = async (candidate, _registry, use) =>
      use({ entrypoint: writeCachedPackage(candidate), version: '1.0.0' }, async () => {});
    await withFixture(
      async ({ configPath, routes }) => {
        rejectReload = true;
        const response = await installPlugin(routes, { packageName, confirmed: true });

        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ ok: false, error: { code: 'reload_failed' } });
        expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([]);
      },
      {
        config: { plugins: [], providers: {} },
        descriptors: new Map([[packageName, emptyDescriptor()]]),
        testHooks: {
          createRouter: (providers) => {
            if (rejectReload) throw new Error('reload rejected for test');
            return new Router(providers);
          },
          pluginControlPlane: { withInstalledNpmPackage },
        },
      },
    );
  });

  test('DELETE /plugins/uninstall rejects built-ins and never treats scoped names as path segments', async () => {
    await withFixture(async ({ routes }) => {
      const response = await uninstallPlugin(routes, { packageName: builtInPackage });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, error: { code: 'builtin_plugin' } });
      expect((await routes.request(`/plugins/${builtInPackage}`)).status).toBe(404);
    });
  });

  test('DELETE /plugins/uninstall preserves secrets when runtime reload rejects removal', async () => {
    let rejectReload = false;
    await withFixture(
      async ({ configPath, repository, routes }) => {
        rejectReload = true;
        const response = await uninstallPlugin(routes, { packageName: configurablePackage });

        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ ok: false, error: { code: 'reload_failed' } });
        expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([
          [configurablePackage, { endpoint: 'https://public.example' }],
        ]);
        expect(repository.readPluginSecret(configurablePackage)?.value).toEqual({ token: 'original-secret' });
      },
      {
        config: {
          plugins: [[configurablePackage, { endpoint: 'https://public.example' }]],
          providers: {},
        },
        prepare: (repository) => {
          repository.writePluginSecret(configurablePackage, null, { token: 'original-secret' });
          Object.defineProperty(repository, 'writePluginSecret', {
            value: () => {
              throw new Error('secret restoration failed');
            },
          });
        },
        testHooks: {
          createRouter: (providers) => {
            if (rejectReload) throw new Error('reload rejected for test');
            return new Router(providers);
          },
        },
      },
    );
  });

  test('DELETE /plugins/uninstall removes Plugin state when the npm cache is already absent', async () => {
    await withFixture(
      async ({ configPath, repository, routes }) => {
        rmSync(npmPackageCacheDir(configurablePackage), { force: true, recursive: true });

        const response = await uninstallPlugin(routes, { packageName: configurablePackage });

        expect(response.status).toBe(200);
        expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([]);
        expect(repository.readPluginSecret(configurablePackage)).toBeNull();
      },
      {
        config: {
          plugins: [[configurablePackage, { endpoint: 'https://public.example' }]],
          providers: {},
        },
        prepare: (repository) => {
          repository.writePluginSecret(configurablePackage, null, { token: 'remove-me' });
        },
      },
    );
  });

  test.each([
    ['direct', ` ${configurablePackage} `],
    ['template', '{{env.WHITESPACE_PLUGIN_PACKAGE}}'],
  ] as const)(
    'DELETE /plugins/uninstall removes a %s whitespace-authored Plugin enablement',
    async (source, authoredPackage) => {
      const previous = process.env['WHITESPACE_PLUGIN_PACKAGE'];
      process.env['WHITESPACE_PLUGIN_PACKAGE'] = ` ${configurablePackage} `;
      try {
        await withFixture(
          async ({ configPath, repository, routes }) => {
            const response = await uninstallPlugin(routes, { packageName: configurablePackage });

            expect(response.status).toBe(200);
            expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([]);
            expect(repository.readPluginSecret(configurablePackage)).toBeNull();
            expect(existsSync(npmPackageCacheDir(configurablePackage))).toBe(false);
          },
          {
            config: {
              plugins: [[authoredPackage, { endpoint: 'https://public.example' }]],
              providers: {},
            },
            prepare: (repository) => {
              repository.writePluginSecret(configurablePackage, null, { token: `${source}-secret` });
            },
          },
        );
      } finally {
        if (previous === undefined) delete process.env['WHITESPACE_PLUGIN_PACKAGE'];
        else process.env['WHITESPACE_PLUGIN_PACKAGE'] = previous;
      }
    },
  );

  test('DELETE /plugins/uninstall resolves OAuth and AI SDK package templates and returns dependent Provider IDs', async () => {
    const packageName = '@scope/dependency-plugin';
    const previousDependency = process.env['PLUGIN_DEPENDENCY_PACKAGE'];
    process.env['PLUGIN_DEPENDENCY_PACKAGE'] = packageName;
    try {
      await withFixture(
        async ({ configPath, routes }) => {
          const before = await Bun.file(configPath).text();
          const response = await uninstallPlugin(routes, { packageName });

          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({
            ok: false,
            error: { code: 'dependent_providers', providerIds: ['oauth-provider', 'sdk-provider'] },
          });
          expect(await Bun.file(configPath).text()).toBe(before);
        },
        {
          config: {
            plugins: [packageName],
            providers: {
              'oauth-provider': {
                kind: 'oauth',
                plugin: '{{env.PLUGIN_DEPENDENCY_PACKAGE}}',
                capability: 'login',
              },
              'sdk-provider': {
                kind: 'ai-sdk',
                packageName: '{{env.PLUGIN_DEPENDENCY_PACKAGE}}',
              },
            },
          },
          providerInstances: [],
        },
      );
    } finally {
      if (previousDependency === undefined) delete process.env['PLUGIN_DEPENDENCY_PACKAGE'];
      else process.env['PLUGIN_DEPENDENCY_PACKAGE'] = previousDependency;
    }
  });

  test('DELETE /plugins/uninstall normalizes direct and template Provider package dependencies', async () => {
    const packageName = '@scope/whitespace-dependency-plugin';
    const variable = 'WHITESPACE_PROVIDER_PACKAGE';
    const previous = process.env[variable];
    process.env[variable] = ` ${packageName} `;
    try {
      await withFixture(
        async ({ configPath, repository, routes }) => {
          writeCachedPackage(packageName);
          const before = await Bun.file(configPath).text();
          const response = await uninstallPlugin(routes, { packageName });

          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({
            ok: false,
            error: {
              code: 'dependent_providers',
              providerIds: ['oauth-direct', 'oauth-template', 'sdk-direct', 'sdk-template'],
            },
          });
          expect(await Bun.file(configPath).text()).toBe(before);
          expect(repository.readPluginSecret(packageName)?.value).toEqual({ token: 'preserved-secret' });
          expect(existsSync(npmPackageCacheDir(packageName))).toBe(true);
        },
        {
          config: {
            plugins: [packageName],
            providers: {
              'oauth-direct': {
                kind: 'oauth',
                plugin: ` ${packageName} `,
                capability: 'login',
              },
              'oauth-template': {
                kind: 'oauth',
                plugin: `{{env.${variable}}}`,
                capability: 'login',
              },
              'sdk-direct': { kind: 'ai-sdk', packageName: ` ${packageName} ` },
              'sdk-template': { kind: 'ai-sdk', packageName: `{{env.${variable}}}` },
            },
          },
          prepare: (repository) => {
            repository.writePluginSecret(packageName, null, { token: 'preserved-secret' });
          },
          providerInstances: [],
        },
      );
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  test('DELETE /plugins/uninstall protects the implicit OpenAI-compatible AI SDK package', async () => {
    const packageName = '@ai-sdk/openai-compatible';
    await withFixture(
      async ({ configPath, repository, routes }) => {
        writeCachedPackage(packageName);
        const before = await Bun.file(configPath).text();
        const response = await uninstallPlugin(routes, { packageName });

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          ok: false,
          error: { code: 'dependent_providers', providerIds: ['implicit-sdk'] },
        });
        expect(await Bun.file(configPath).text()).toBe(before);
        expect(repository.readPluginSecret(packageName)?.value).toEqual({ token: 'preserved-secret' });
        expect(existsSync(npmPackageCacheDir(packageName))).toBe(true);
      },
      {
        config: {
          plugins: [],
          providers: {
            'implicit-sdk': {
              kind: 'ai-sdk',
              package: ' @ai-sdk/anthropic ',
              options: { baseURL: 'https://api.example.test/v1', name: 'compatible' },
              models: ['model'],
            },
          },
        },
        prepare: (repository) => {
          repository.writePluginSecret(packageName, null, { token: 'preserved-secret' });
        },
        providerInstances: [],
      },
    );
  });

  test('DELETE /plugins/uninstall protects direct and template whitespace-authored legacy AI SDK packages', async () => {
    const packageName = '@ai-sdk/anthropic';
    const variable = 'WHITESPACE_LEGACY_PACKAGE';
    const previous = process.env[variable];
    process.env[variable] = ` ${packageName} `;
    try {
      await withFixture(
        async ({ configPath, repository, routes }) => {
          writeCachedPackage(packageName);
          const before = await Bun.file(configPath).text();
          const response = await uninstallPlugin(routes, { packageName });

          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({
            ok: false,
            error: { code: 'dependent_providers', providerIds: ['legacy-direct', 'legacy-template'] },
          });
          expect(await Bun.file(configPath).text()).toBe(before);
          expect(repository.readPluginSecret(packageName)?.value).toEqual({ token: 'preserved-secret' });
          expect(existsSync(npmPackageCacheDir(packageName))).toBe(true);
        },
        {
          config: {
            plugins: [],
            providers: {
              'legacy-direct': {
                kind: 'ai-sdk',
                package: ` ${packageName} `,
                options: { baseURL: 'https://api.example.test/v1', name: 'compatible' },
                models: ['model'],
              },
              'legacy-template': {
                kind: 'ai-sdk',
                package: `{{env.${variable}}}`,
                options: { baseURL: 'https://api.example.test/v1', name: 'compatible' },
                models: ['model'],
              },
            },
          },
          prepare: (repository) => {
            repository.writePluginSecret(packageName, null, { token: 'preserved-secret' });
          },
          providerInstances: [],
        },
      );
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  test('DELETE /plugins/uninstall keeps the npm cache when a Provider dependency appears under the cache lock', async () => {
    const packageName = '@scope/cache-race-plugin';
    let configFile: AtomicConfigFile;
    let cacheRemoved = false;
    const removeNpmPackageCache: NonNullable<
      NonNullable<ServerStateTestHooks['pluginControlPlane']>['removeNpmPackageCache']
    > = async (_candidate, _canRemove, coordinate) => {
      await configFile.replace((current) => ({
        ...current,
        providers: {
          ...(current['providers'] as Record<string, unknown>),
          'late-sdk': { kind: 'ai-sdk', packageName: ` ${packageName} ` },
        },
      }));
      const remove = async () => {
        cacheRemoved = true;
        return true;
      };
      return coordinate === undefined ? remove() : coordinate(remove);
    };
    await withFixture(
      async ({ configPath, repository, routes }) => {
        configFile = new AtomicConfigFile(configPath);
        const response = await uninstallPlugin(routes, { packageName });

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          ok: false,
          error: { code: 'dependent_providers', providerIds: ['late-sdk'] },
        });
        expect(cacheRemoved).toBe(false);
        expect(repository.readPluginSecret(packageName)?.value).toEqual({ token: 'remove-me' });
        expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([packageName]);
      },
      {
        config: { plugins: [packageName], providers: {} },
        prepare: (repository) => {
          repository.writePluginSecret(packageName, null, { token: 'remove-me' });
        },
        providerInstances: [],
        testHooks: { pluginControlPlane: { removeNpmPackageCache } },
      },
    );
  });

  test('DELETE /plugins/uninstall holds the config lock through its final cross-process cache guard', async () => {
    const packageName = '@scope/cross-process-cache-race-plugin';
    let configFile: AtomicConfigFile;
    let guardProvided = false;
    let externalEnteredBeforeRemoval = false;
    let externalWrite: Promise<void> | undefined;
    let externalMutationEntered!: () => void;
    const externalEntered = new Promise<void>((resolve) => (externalMutationEntered = resolve));
    let releaseExternalMutation!: () => void;
    const externalMutationReleased = new Promise<void>((resolve) => (releaseExternalMutation = resolve));
    const removeNpmPackageCache: NonNullable<
      NonNullable<ServerStateTestHooks['pluginControlPlane']>['removeNpmPackageCache']
    > = async (candidate, canRemove, coordinate) => {
      guardProvided = canRemove !== undefined;
      const remove = async () => {
        externalWrite = configFile.replace(async (current) => {
          externalMutationEntered();
          await externalMutationReleased;
          return {
            ...current,
            providers: {
              ...(current['providers'] as Record<string, unknown>),
              'external-sdk': { kind: 'ai-sdk', packageName },
            },
          };
        });
        externalEnteredBeforeRemoval =
          (await Promise.race([externalEntered.then(() => true), Bun.sleep(100).then(() => false)])) === true;
        const allowed = (await canRemove?.()) ?? false;
        if (!allowed) return false;
        rmSync(npmPackageCacheDir(candidate), { force: true, recursive: true });
        return true;
      };
      try {
        return coordinate === undefined ? remove() : coordinate(remove);
      } finally {
        releaseExternalMutation();
      }
    };

    await withFixture(
      async ({ configPath, routes }) => {
        configFile = new AtomicConfigFile(configPath);
        writeCachedPackage(packageName);

        const response = await uninstallPlugin(routes, { packageName });
        await externalWrite;

        expect(response.status).toBe(200);
        expect(guardProvided).toBe(true);
        expect(externalEnteredBeforeRemoval).toBe(false);
        expect(existsSync(npmPackageCacheDir(packageName))).toBe(false);
      },
      {
        config: { plugins: [packageName], providers: {} },
        descriptors: new Map([[packageName, emptyDescriptor()]]),
        providerInstances: [],
        testHooks: { pluginControlPlane: { removeNpmPackageCache } },
      },
    );
  });

  test('DELETE /plugins/uninstall rejects a Provider dependency committed after its removal snapshot', async () => {
    const packageName = '@scope/provider-commit-race-plugin';
    let removalSnapshotTaken!: () => void;
    const snapshotTaken = new Promise<void>((resolve) => (removalSnapshotTaken = resolve));
    let providerCommitted!: () => void;
    const committed = new Promise<void>((resolve) => (providerCommitted = resolve));
    type RemovalCoordinator = (remove: () => Promise<boolean>) => Promise<boolean>;
    const removeNpmPackageCache = (async (...raw: unknown[]) => {
      const [candidate, canRemove, coordinate] = raw as [
        string,
        (() => Promise<boolean>) | undefined,
        RemovalCoordinator | undefined,
      ];
      removalSnapshotTaken();
      await committed;
      const remove = async () => {
        if (canRemove !== undefined && !(await canRemove())) return false;
        rmSync(npmPackageCacheDir(candidate), { force: true, recursive: true });
        return true;
      };
      return coordinate === undefined ? remove() : coordinate(remove);
    }) as NonNullable<NonNullable<ServerStateTestHooks['pluginControlPlane']>['removeNpmPackageCache']>;

    await withFixture(
      async ({ configPath, routes }) => {
        writeCachedPackage(packageName);
        const uninstalling = uninstallPlugin(routes, { packageName });
        await snapshotTaken;
        let provider!: Response;
        try {
          provider = await routes.request('/providers', {
            body: JSON.stringify({ id: 'late-sdk', kind: 'ai-sdk', packageName }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          });
        } finally {
          providerCommitted();
        }
        const response = await uninstalling;

        expect(provider.status).toBe(201);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          ok: false,
          error: { code: 'dependent_providers', providerIds: ['late-sdk'] },
        });
        expect(existsSync(npmPackageCacheDir(packageName))).toBe(true);
        expect(JSON.parse(await Bun.file(configPath).text())).toMatchObject({
          plugins: [packageName],
          providers: { 'late-sdk': { kind: 'ai-sdk', packageName } },
        });
      },
      {
        config: { plugins: [packageName], providers: {} },
        descriptors: new Map([[packageName, emptyDescriptor()]]),
        providerInstances: [],
        testHooks: { pluginControlPlane: { removeNpmPackageCache } },
      },
    );
  });

  test('DELETE /plugins/uninstall preserves Plugin state when OAuth commits after its removal snapshot', async () => {
    const packageName = '@scope/oauth-cache-race-plugin';
    const endpoint = 'https://oauth-cache-race.example.test';
    let deviceCodePresented!: () => void;
    const deviceCodeReady = new Promise<void>((resolve) => (deviceCodePresented = resolve));
    let releaseLogin!: () => void;
    const loginReleased = new Promise<void>((resolve) => (releaseLogin = resolve));
    const descriptor = oauthRaceDescriptor(deviceCodePresented, loginReleased);
    let removalSnapshotTaken!: () => void;
    const snapshotTaken = new Promise<void>((resolve) => (removalSnapshotTaken = resolve));
    let providerCommitted!: () => void;
    const committed = new Promise<void>((resolve) => (providerCommitted = resolve));
    type RemovalCoordinator = (remove: () => Promise<boolean>) => Promise<boolean>;
    const removeNpmPackageCache = (async (...raw: unknown[]) => {
      const [candidate, canRemove, coordinate] = raw as [
        string,
        (() => Promise<boolean>) | undefined,
        RemovalCoordinator | undefined,
      ];
      removalSnapshotTaken();
      await committed;
      const remove = async () => {
        if (canRemove !== undefined && !(await canRemove())) return false;
        rmSync(npmPackageCacheDir(candidate), { force: true, recursive: true });
        return true;
      };
      return coordinate === undefined ? remove() : coordinate(remove);
    }) as NonNullable<NonNullable<ServerStateTestHooks['pluginControlPlane']>['removeNpmPackageCache']>;

    await withFixture(
      async ({ configPath, repository, routes }) => {
        const started = await routes.request('/oauth/sessions', {
          body: JSON.stringify({
            capability: { plugin: packageName, capability: 'default' },
            publicValues: {},
            secrets: {},
            clearSecrets: [],
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        expect(started.status).toBe(202);
        await deviceCodeReady;

        const uninstalling = uninstallPlugin(routes, { packageName });
        await snapshotTaken;
        releaseLogin();

        let provider: unknown;
        try {
          provider = await waitForProvider(configPath, 'person');
        } finally {
          providerCommitted();
        }
        const response = await uninstalling;

        expect(provider).toMatchObject({ kind: 'oauth', plugin: packageName });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          ok: false,
          error: { code: 'dependent_providers', providerIds: ['person'] },
        });
        expect(JSON.parse(await Bun.file(configPath).text())).toMatchObject({
          plugins: [[packageName, { endpoint }]],
          providers: { person: { kind: 'oauth', plugin: packageName } },
        });
        expect(repository.readPluginSecret(packageName)?.value).toEqual({ token: 'preserved-secret' });
        expect(existsSync(npmPackageCacheDir(packageName))).toBe(true);
      },
      {
        config: { plugins: [[packageName, { endpoint }]], providers: {} },
        descriptors: new Map([[packageName, descriptor]]),
        prepare: (repository) => {
          writeCachedPackage(packageName);
          repository.writePluginSecret(packageName, null, { token: 'preserved-secret' });
        },
        testHooks: { pluginControlPlane: { removeNpmPackageCache } },
      },
    );
  });

  test('OAuth rejects its final Provider commit when Plugin uninstall wins the mutation queue', async () => {
    const packageName = '@scope/oauth-uninstall-wins-plugin';
    const endpoint = 'https://oauth-uninstall-wins.example.test';
    let deviceCodePresented!: () => void;
    const deviceCodeReady = new Promise<void>((resolve) => (deviceCodePresented = resolve));
    let releaseLogin!: () => void;
    const loginReleased = new Promise<void>((resolve) => (releaseLogin = resolve));
    const descriptor = oauthRaceDescriptor(deviceCodePresented, loginReleased);

    await withFixture(
      async ({ configPath, repository, routes }) => {
        const started = await routes.request('/oauth/sessions', {
          body: JSON.stringify({
            capability: { plugin: packageName, capability: 'default' },
            publicValues: {},
            secrets: {},
            clearSecrets: [],
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        expect(started.status).toBe(202);
        const { session } = (await started.json()) as { session: { id: string } };
        await deviceCodeReady;

        const response = await uninstallPlugin(routes, { packageName });
        expect(response.status).toBe(200);
        expect(JSON.parse(await Bun.file(configPath).text())).toMatchObject({ plugins: [], providers: {} });
        expect(repository.readPluginSecret(packageName)).toBeNull();
        expect(existsSync(npmPackageCacheDir(packageName))).toBe(false);

        releaseLogin();
        const completed = await waitForOAuthSession(
          routes,
          session.id,
          ({ status }) => status === 'failed' || status === 'succeeded',
        );

        expect(completed).toEqual({
          id: session.id,
          status: 'failed',
          code: 'OAUTH_CAPABILITY_UNAVAILABLE',
        });
        expect(JSON.parse(await Bun.file(configPath).text()).providers).toEqual({});
        expect(repository.readAccount('person')).toBeNull();
      },
      {
        config: { plugins: [[packageName, { endpoint }]], providers: {} },
        descriptors: new Map([[packageName, descriptor]]),
        prepare: (repository) => {
          writeCachedPackage(packageName);
          repository.writePluginSecret(packageName, null, { token: 'remove-me' });
        },
      },
    );
  });

  test('install and uninstall serialize the package generation across classification, commit, and removal', async () => {
    const packageName = '@scope/install-uninstall-race';
    const lifecycle = serializedLifecycle();
    let startInstall!: () => void;
    const installStarted = new Promise<void>((resolve) => (startInstall = resolve));
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => (releaseInstall = resolve));
    let cacheRemoved = false;
    const withInstalledNpmPackage: NonNullable<
      NonNullable<ServerStateTestHooks['pluginControlPlane']>['withInstalledNpmPackage']
    > = (candidate, _registry, use) =>
      lifecycle(candidate, async (assertOwnership) => {
        const installed = { entrypoint: writeCachedPackage(candidate), version: '1.0.0' };
        startInstall();
        await installGate;
        return use(installed, assertOwnership);
      });
    const removeNpmPackageCache: NonNullable<
      NonNullable<ServerStateTestHooks['pluginControlPlane']>['removeNpmPackageCache']
    > = (candidate, canRemove, coordinate) =>
      lifecycle(candidate, async () => {
        const remove = async () => {
          if (canRemove !== undefined && !(await canRemove())) return false;
          cacheRemoved = true;
          return true;
        };
        return coordinate === undefined ? remove() : coordinate(remove);
      });
    await withFixture(
      async ({ configPath, routes }) => {
        const installing = installPlugin(routes, { packageName, confirmed: true });
        await installStarted;
        const uninstalling = uninstallPlugin(routes, { packageName });
        releaseInstall();
        const [installed, uninstalled] = await Promise.all([installing, uninstalling]);

        expect(installed.status).toBe(201);
        expect(uninstalled.status).toBe(200);
        expect(cacheRemoved).toBe(true);
        expect(JSON.parse(await Bun.file(configPath).text()).plugins).toEqual([]);
      },
      {
        config: { plugins: [], providers: {} },
        descriptors: new Map([[packageName, emptyDescriptor()]]),
        testHooks: {
          pluginControlPlane: {
            removeNpmPackageCache,
            withInstalledNpmPackage,
            withNpmPackageLifecycle: lifecycle,
          },
        },
      },
    );
  });
});
