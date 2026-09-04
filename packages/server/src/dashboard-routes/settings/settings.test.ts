import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRuntimeConfig, Router } from '@aio-proxy/core';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import type { ServerState } from '../../server-state';
import { createDashboardRoutes } from '../config';

const authoredConfig = {
  futureRoot: { secret: 'root-preserved' },
  plugins: [],
  providers: {},
  proxy: '{{env.SETTINGS_ROOT_PROXY}}',
  router: { modelContextAggregation: 'min', futureRouter: true },
  server: {
    apiKeys: [{ key: '{{env.SETTINGS_API_KEY}}', label: 'ci' }, { key: 'sk-plain-preserved' }],
    futureServer: 'server-preserved',
    host: '{{env.SETTINGS_HOST}}',
    logging: {
      dir: '{{env.SETTINGS_LOG_DIR}}',
      enabled: false,
      futureLogging: 'logging-preserved',
      level: 'info',
      retentionDays: 3,
    },
    password: 'password-preserved',
    port: 9_317,
    retry: { futureRetry: 'retry-preserved', retryAfterCapMs: 30_000 },
  },
};

type Routes = ReturnType<typeof createDashboardRoutes>;

async function withSettingsFixture(
  run: (fixture: {
    readonly configPath: string;
    readonly routes: Routes;
    readonly state: ServerState;
  }) => Promise<void>,
  options: { readonly configPath?: boolean; readonly rejectReload?: { value: boolean } } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'aio-dashboard-settings-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(authoredConfig, null, 2));
  const previous = {
    SETTINGS_API_KEY: process.env['SETTINGS_API_KEY'],
    SETTINGS_HOST: process.env['SETTINGS_HOST'],
    SETTINGS_LOG_DIR: process.env['SETTINGS_LOG_DIR'],
    SETTINGS_PROXY_HOST: process.env['SETTINGS_PROXY_HOST'],
    SETTINGS_ROOT_PROXY: process.env['SETTINGS_ROOT_PROXY'],
  };
  process.env['SETTINGS_API_KEY'] = 'sk-from-env';
  process.env['SETTINGS_HOST'] = '127.0.0.1';
  process.env['SETTINGS_LOG_DIR'] = '/tmp/settings-logs';
  process.env['SETTINGS_PROXY_HOST'] = 'replacement.proxy.example';
  process.env['SETTINGS_ROOT_PROXY'] = 'http://user:password@proxy.example:8080';
  const rejectReload = options.rejectReload;
  const state = await createServerState({
    config: parseRuntimeConfig(authoredConfig),
    dbHome: directory,
    ...(options.configPath === false ? {} : { configPath }),
    watchConfig: false,
    ...(rejectReload === undefined
      ? {}
      : {
          __test: {
            createRouter: (providers) => {
              if (rejectReload.value) throw new Error('reload rejected for test');
              return new Router(providers);
            },
          },
        }),
  });

  try {
    await run({ configPath, routes: createDashboardRoutes(state, disabledDashboardAuthentication), state });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function put(routes: Routes, body: unknown): Promise<Response> {
  return routes.request('/settings', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'PUT',
  });
}

function onDisk(configPath: string): typeof authoredConfig {
  return JSON.parse(readFileSync(configPath, 'utf8')) as typeof authoredConfig;
}

async function apiKeysRevision(routes: Routes): Promise<string> {
  const view = (await (await routes.request('/settings')).json()) as { readonly apiKeysRevision: string };
  return view.apiKeysRevision;
}

// Every key write carries the revision the client read, so the fixtures round-trip through GET.
async function putKeys(routes: Routes, apiKeys: unknown): Promise<Response> {
  return put(routes, { apiKeys, apiKeysRevision: await apiKeysRevision(routes) });
}

test('GET /settings returns only the redacted typed settings view', async () => {
  await withSettingsFixture(async ({ routes }) => {
    const response = await routes.request('/settings');
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      apiKeys: [{ key: '****', label: 'ci' }, { key: '****' }],
      apiKeysRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      hasPassword: true,
      host: '127.0.0.1',
      logging: { enabled: false, level: 'info', retentionDays: 3 },
      port: 9_317,
      proxy: '****',
      retryAfterCapMs: 30_000,
    });
    expect(text).not.toMatch(
      /password-preserved|user:password|SETTINGS_|root-preserved|sk-from-env|sk-plain-preserved/u,
    );
  });
});

test('GET /settings masks the enforced keys when the server runs without a config file', async () => {
  await withSettingsFixture(
    async ({ routes }) => {
      // Keys stay enforced without a file to write back to, so reporting none would
      // tell the operator access is open when it is not.
      const view = (await (await routes.request('/settings')).json()) as { readonly apiKeys: unknown };

      expect(view.apiKeys).toEqual([{ key: '****', label: 'ci' }, { key: '****' }]);
    },
    { configPath: false },
  );
});

test('the API key revision is not the bare digest of the authored array', async () => {
  await withSettingsFixture(async ({ routes }) => {
    // A plain sha256 over the authored entries is an offline verifier for the very
    // secrets the view masks: the labels and ordering ship in the same response.
    const bare = createHash('sha256')
      .update(JSON.stringify([{ key: 'sk-from-env', label: 'ci' }, { key: 'sk-plain-preserved' }]))
      .digest('hex');
    const authored = createHash('sha256')
      .update(JSON.stringify([{ key: '{{env.SETTINGS_API_KEY}}', label: 'ci' }, { key: 'sk-plain-preserved' }]))
      .digest('hex');

    const revision = await apiKeysRevision(routes);

    expect(revision).not.toBe(`sha256:${bare}`);
    expect(revision).not.toBe(`sha256:${authored}`);
  });
});

test('PUT /settings changes only owned authoring fields', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, {
      logging: { enabled: true, level: 'warn', retentionDays: 30 },
      retryAfterCapMs: 15_000,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      restartRequired: true,
      settings: {
        logging: { enabled: true, level: 'warn', retentionDays: 30 },
        retryAfterCapMs: 15_000,
      },
    });
    const stored = onDisk(configPath);
    expect(stored.futureRoot).toEqual(authoredConfig.futureRoot);
    expect(stored.proxy).toBe(authoredConfig.proxy);
    expect(stored.router).toEqual(authoredConfig.router);
    expect(stored.server.futureServer).toBe(authoredConfig.server.futureServer);
    expect(stored.server.host).toBe(authoredConfig.server.host);
    expect(stored.server.password).toBe(authoredConfig.server.password);
    expect(stored.server.logging.dir).toBe(authoredConfig.server.logging.dir);
    expect(stored.server.logging.futureLogging).toBe(authoredConfig.server.logging.futureLogging);
    expect(stored.server.retry.futureRetry).toBe(authoredConfig.server.retry.futureRetry);
  });
});

test('an omitted root proxy is preserved', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { retryAfterCapMs: 10_000 });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, restartRequired: false });
    expect(onDisk(configPath).proxy).toBe(authoredConfig.proxy);
  });
});

test('a null root proxy deletes the authored value', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { proxy: null });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      restartRequired: false,
      settings: { proxy: null },
    });
    expect(onDisk(configPath)).not.toHaveProperty('proxy');
  });
});

test('a valid root proxy template replaces the authored value without exposing its expansion', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const proxy = 'https://{{env.SETTINGS_PROXY_HOST}}:8443';
    const response = await put(routes, { proxy });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      restartRequired: false,
      settings: { proxy: '****' },
    });
    expect(onDisk(configPath).proxy).toBe(proxy);
  });
});

test('invalid port, SOCKS proxy, and malformed template return 422 without changing config bytes', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const before = readFileSync(configPath, 'utf8');
    for (const body of [
      { port: 0 },
      { proxy: 'socks5://proxy.example:1080' },
      { proxy: 'https://{{#if true}}proxy.example{{/if}}' },
    ]) {
      const response = await put(routes, body);

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
      expect(readFileSync(configPath, 'utf8')).toBe(before);
    }
  });
});

test('PUT /settings returns 409 when no config path is configured', async () => {
  await withSettingsFixture(
    async ({ routes }) => {
      const response = await put(routes, { port: 9_318 });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, error: { code: 'config_unavailable' } });
    },
    { configPath: false },
  );
});

test('a rejected runtime reload returns 422 and rolls back the config bytes', async () => {
  const rejectReload = { value: false };
  await withSettingsFixture(
    async ({ configPath, routes }) => {
      const before = readFileSync(configPath, 'utf8');
      rejectReload.value = true;

      const response = await put(routes, { retryAfterCapMs: 12_345 });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ ok: false, error: { code: 'reload_failed' } });
      expect(readFileSync(configPath, 'utf8')).toBe(before);
    },
    { rejectReload },
  );
});

test('persisted host, port, and logging changes require restart', async () => {
  await withSettingsFixture(async ({ routes }) => {
    for (const body of [{ host: 'localhost' }, { port: 9_318 }, { logging: { level: 'debug' } }]) {
      const response = await put(routes, body);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, restartRequired: true });
    }
  });
});

test('theme, language, and router fields are rejected without changing config bytes', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const before = readFileSync(configPath, 'utf8');
    for (const body of [{ theme: 'dark' }, { language: 'en' }, { router: { modelContextAggregation: 'max' } }]) {
      const response = await put(routes, body);

      expect(response.status).toBe(422);
      expect(readFileSync(configPath, 'utf8')).toBe(before);
    }
  });
});

test('a new password is stored only as an Argon2id hash and never in plaintext', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { password: 'correct horse battery' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, settings: { hasPassword: true } });

    const stored = onDisk(configPath);
    expect(stored.server.password).toStartWith('$argon2id$');
    expect(await Bun.password.verify('correct horse battery', stored.server.password)).toBe(true);
    expect(readFileSync(configPath, 'utf8')).not.toContain('correct horse battery');
  });
});

test('a null password removes the authored dashboard password', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { password: null });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, settings: { hasPassword: false } });
    expect(onDisk(configPath).server).not.toHaveProperty('password');
  });
});

test('a password below the minimum length is rejected without changing config bytes', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const before = readFileSync(configPath, 'utf8');

    const response = await put(routes, { password: 'short12' });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

test('a password write does not require restart', async () => {
  await withSettingsFixture(async ({ routes }) => {
    const response = await put(routes, { password: 'correct horse battery' });

    expect(await response.json()).toMatchObject({ ok: true, restartRequired: false });
  });
});

test('a retained API key keeps its authored template byte-for-byte', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await putKeys(routes, [{ retain: 0, label: 'ci-renamed' }, { retain: 1 }]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      settings: { apiKeys: [{ key: '****', label: 'ci-renamed' }, { key: '****' }] },
    });
    expect(onDisk(configPath).server.apiKeys).toEqual([
      { key: '{{env.SETTINGS_API_KEY}}', label: 'ci-renamed' },
      { key: 'sk-plain-preserved' },
    ]);
  });
});

test('retaining a key without a label clears the authored label', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await putKeys(routes, [{ retain: 0 }]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, settings: { apiKeys: [{ key: '****' }] } });
    expect(onDisk(configPath).server.apiKeys).toEqual([{ key: '{{env.SETTINGS_API_KEY}}' }]);
  });
});

test('a new API key is appended and an unlisted authored key is removed', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await putKeys(routes, [
      { retain: 0, label: 'ci' },
      { key: 'sk-added', label: 'laptop' },
    ]);

    expect(response.status).toBe(200);
    expect(onDisk(configPath).server.apiKeys).toEqual([
      { key: '{{env.SETTINGS_API_KEY}}', label: 'ci' },
      { key: 'sk-added', label: 'laptop' },
    ]);
  });
});

test('an empty API key array removes every authored key', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await putKeys(routes, []);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, settings: { apiKeys: [] } });
    expect(onDisk(configPath).server.apiKeys).toEqual([]);
  });
});

test('an omitted API key array preserves the authored keys', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { retryAfterCapMs: 11_000 });

    expect(response.status).toBe(200);
    expect(onDisk(configPath).server.apiKeys).toEqual(authoredConfig.server.apiKeys);
  });
});

test('a retain index outside the authored array and a reserved-prefix key are rejected', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const before = readFileSync(configPath, 'utf8');
    for (const apiKeys of [[{ retain: 5 }], [{ key: 'aio_agent_at_forged' }]]) {
      const response = await putKeys(routes, apiKeys);

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
      expect(readFileSync(configPath, 'utf8')).toBe(before);
    }
  });
});

test('GET /settings derives key rows and their revision from the same authored snapshot', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    // An external edit lands before the watcher reloads, so `currentConfig()` is one snapshot
    // behind. Rows read from it would pair old `retain` indexes with the new file's revision.
    writeFileSync(
      configPath,
      JSON.stringify({
        ...authoredConfig,
        server: { ...authoredConfig.server, apiKeys: [{ key: 'sk-plain-preserved', label: 'moved' }] },
      }),
    );

    const view = (await (await routes.request('/settings')).json()) as {
      readonly apiKeys: readonly { readonly label?: string }[];
      readonly apiKeysRevision: string;
    };

    expect(view.apiKeys).toEqual([{ key: '****', label: 'moved' }]);
    // `retain: 0` now names the same entry the revision was taken over, so the write applies.
    const response = await put(routes, { apiKeys: [{ retain: 0 }], apiKeysRevision: view.apiKeysRevision });
    expect(response.status).toBe(200);
    expect(onDisk(configPath).server.apiKeys).toEqual([{ key: 'sk-plain-preserved' }]);
  });
});

test('a key write against a superseded revision is rejected without changing config bytes', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const stale = await apiKeysRevision(routes);
    // Another writer reorders the authored array, so `retain: 0` now names a different secret.
    expect((await putKeys(routes, [{ retain: 1 }, { retain: 0 }])).status).toBe(200);
    const before = readFileSync(configPath, 'utf8');

    const response = await put(routes, { apiKeys: [{ retain: 0 }], apiKeysRevision: stale });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'stale_api_keys' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

test('GET /settings still serves the enforced keys when the authored file cannot be parsed', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    // The watcher rejected this edit, so the proxy still enforces its last valid snapshot.
    // Failing the read would blank the whole Settings page until the file is repaired.
    writeFileSync(configPath, '{ "server": { "apiKeys": ');

    const response = await routes.request('/settings');
    const view = (await response.json()) as { readonly apiKeys: unknown; readonly apiKeysRevision: string };

    expect(response.status).toBe(200);
    expect(view.apiKeys).toEqual([{ key: '****', label: 'ci' }, { key: '****' }]);
    // A write cannot apply `retain` indexes to an array the client never read, and the file it
    // would rewrite does not parse — so it is refused before any bytes move.
    const before = readFileSync(configPath, 'utf8');
    const write = await put(routes, { apiKeys: [{ retain: 0 }], apiKeysRevision: view.apiKeysRevision });
    expect(write.status).toBe(422);
    expect(await write.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

test('a config whose root parses to a non-object is refused rather than crashing the write', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    // Valid JSON, unusable as a config. This parses cleanly, so it reaches the root check rather
    // than the parser's own error — the write must still answer `config_rejected`, not a 500.
    writeFileSync(configPath, '[]');

    const response = await routes.request('/settings');
    const view = (await response.json()) as { readonly apiKeysRevision: string };
    expect(response.status).toBe(200);

    const before = readFileSync(configPath, 'utf8');
    const write = await put(routes, { apiKeys: [{ retain: 0 }], apiKeysRevision: view.apiKeysRevision });

    expect(write.status).toBe(422);
    expect(await write.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

test('a newly added key is authored even when a retained row already holds that credential', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    // Value equality cannot tell a deliberate second label for one credential from a
    // resubmission after a lost response, and dropping a submitted key is the worse failure:
    // the operator has already handed it out. So the row is authored either way.
    const response = await putKeys(routes, [
      { retain: 0, label: 'ci' },
      { retain: 1 },
      { key: 'sk-plain-preserved', label: 'second-label' },
    ]);

    expect(response.status).toBe(200);
    expect(onDisk(configPath).server.apiKeys).toEqual([
      { key: '{{env.SETTINGS_API_KEY}}', label: 'ci' },
      { key: 'sk-plain-preserved' },
      { key: 'sk-plain-preserved', label: 'second-label' },
    ]);
  });
});

test('a retained duplicate credential survives a label-only edit', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    // The schema permits the same credential under several labels, so retained rows must be
    // written back as authored — deduplicating them would delete an unrelated entry.
    expect(
      (
        await putKeys(routes, [
          { key: 'sk-shared', label: 'first' },
          { key: 'sk-shared', label: 'second' },
        ])
      ).status,
    ).toBe(200);

    const response = await putKeys(routes, [
      { retain: 0, label: 'renamed' },
      { retain: 1, label: 'second' },
    ]);

    expect(response.status).toBe(200);
    expect(onDisk(configPath).server.apiKeys).toEqual([
      { key: 'sk-shared', label: 'renamed' },
      { key: 'sk-shared', label: 'second' },
    ]);
  });
});

test('an API key write does not require restart', async () => {
  await withSettingsFixture(async ({ routes }) => {
    const response = await putKeys(routes, [{ retain: 0 }]);

    expect(await response.json()).toMatchObject({ ok: true, restartRequired: false });
  });
});
