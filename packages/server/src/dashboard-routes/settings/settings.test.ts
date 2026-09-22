import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRuntimeConfig, Router } from '@aio-proxy/core';

import { createServerState } from '#server-test-lifecycle';

import type { AutoUpdateController } from '../../auto-update';
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
    readonly logs: readonly { readonly event: string }[];
    readonly routes: Routes;
    readonly state: ServerState;
  }) => Promise<void>,
  options: {
    readonly configPath?: boolean;
    readonly host?: string;
    readonly rejectReload?: { value: boolean };
    readonly controller?: AutoUpdateController;
  } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'aio-dashboard-settings-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(authoredConfig, null, 2));
  const previous = {
    SETTINGS_API_KEY: process.env['SETTINGS_API_KEY'],
    SETTINGS_HOST: process.env['SETTINGS_HOST'],
    SETTINGS_LOG_DIR: process.env['SETTINGS_LOG_DIR'],
    SETTINGS_OTLP_TOKEN: process.env['SETTINGS_OTLP_TOKEN'],
    SETTINGS_PROXY_HOST: process.env['SETTINGS_PROXY_HOST'],
    SETTINGS_ROOT_PROXY: process.env['SETTINGS_ROOT_PROXY'],
  };
  process.env['SETTINGS_API_KEY'] = 'sk-from-env';
  process.env['SETTINGS_OTLP_TOKEN'] = 'otlp-from-env';
  process.env['SETTINGS_HOST'] = '127.0.0.1';
  process.env['SETTINGS_LOG_DIR'] = '/tmp/settings-logs';
  process.env['SETTINGS_PROXY_HOST'] = 'replacement.proxy.example';
  process.env['SETTINGS_ROOT_PROXY'] = 'http://user:password@proxy.example:8080';
  const rejectReload = options.rejectReload;
  const logs: { readonly event: string }[] = [];
  const state = await createServerState({
    config: parseRuntimeConfig(authoredConfig),
    dbHome: directory,
    logger: (entry) => logs.push(entry as { readonly event: string }),
    ...(options.host === undefined ? {} : { host: options.host }),
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
    await run({
      configPath,
      logs,
      routes: createDashboardRoutes(state, disabledDashboardAuthentication, '0.0.0', options.controller),
      state,
    });
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

test('PUT /settings leaves a leftover autoUpdate key on disk', async () => {
  await withSettingsFixture(async ({ routes, configPath }) => {
    const current = onDisk(configPath);
    writeFileSync(configPath, JSON.stringify({ ...current, server: { ...current.server, autoUpdate: true } }, null, 2));
    const response = await put(routes, { retryAfterCapMs: 5_000 });
    expect(response.status).toBe(200);
    expect(onDisk(configPath).server).toMatchObject({ autoUpdate: true, retry: { retryAfterCapMs: 5_000 } });
  });
});

test('GET /settings serves the authored caller keys and redacts only the root proxy', async () => {
  await withSettingsFixture(async ({ routes }) => {
    const response = await routes.request('/settings');
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      // Authored, not expanded and not masked: the editor round-trips these rows back through
      // PUT, so a mask would be written over the credential and `sk-from-env` over the template.
      apiKeys: [{ key: '{{env.SETTINGS_API_KEY}}', label: 'ci' }, { key: 'sk-plain-preserved' }],
      hasPassword: true,
      host: '127.0.0.1',
      logging: { enabled: false, level: 'info', retentionDays: 3 },
      port: 9_317,
      proxy: '****',
      proxyBackup: null,
      proxyFallback: false,
      requireApiKey: true,
      retryAfterCapMs: 30_000,
      otel: { destinations: [] },
    });
    // The proxy carries `user:password@`, which has no editor round-trip, and the dashboard
    // password hash is never a form value — both stay out of the response.
    expect(text).not.toMatch(/password-preserved|user:password|root-preserved|sk-from-env/u);
  });
});

test('GET /settings falls back to the enforced keys when the authored file is missing or unparseable', async () => {
  // Keys stay enforced without a writable file, so reporting none would tell the operator access
  // is open when it is not. The expansion is what the runtime holds; PUT is refused either way.
  const enforced = [{ key: 'sk-from-env', label: 'ci' }, { key: 'sk-plain-preserved' }];
  await withSettingsFixture(
    async ({ routes }) => {
      expect(await (await routes.request('/settings')).json()).toMatchObject({ apiKeys: enforced });
    },
    { configPath: false },
  );
  await withSettingsFixture(async ({ configPath, routes }) => {
    // The watcher rejected this edit, so the proxy still enforces its last valid snapshot.
    // Failing the read would blank the whole Settings page until the file is repaired.
    writeFileSync(configPath, '{ "server": { "apiKeys": ');

    const response = await routes.request('/settings');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ apiKeys: enforced });
    const before = readFileSync(configPath, 'utf8');
    const write = await put(routes, { apiKeys: [{ key: 'sk-added' }] });
    expect(write.status).toBe(422);
    expect(await write.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
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

test('invalid port, unsupported proxy, and malformed template return 422 without changing config bytes', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const before = readFileSync(configPath, 'utf8');
    for (const body of [
      { port: 0 },
      { proxy: 'ftp://proxy.example:1080' },
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

test('an API key array is authored wholesale, templates byte-for-byte', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    // A resubmitted template must land as the reference the view served, not as its expansion:
    // writing `sk-from-env` here would burn the secret into the config file.
    const apiKeys = [
      { key: '{{env.SETTINGS_API_KEY}}', label: 'ci-renamed' },
      { key: 'sk-added', label: 'laptop' },
    ];
    const response = await put(routes, { apiKeys });

    expect(response.status).toBe(200);
    // Unlisted authored keys are gone, and the write is hot: the middleware reads the policy
    // from `currentConfig()` per request, so the reload is the whole rollout.
    expect(await response.json()).toMatchObject({ ok: true, restartRequired: false, settings: { apiKeys } });
    expect(onDisk(configPath).server.apiKeys).toEqual(apiKeys);
  });
});

test('an empty API key array removes every authored key', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { apiKeys: [] });

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

test('a reserved-prefix API key is rejected without changing config bytes', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const before = readFileSync(configPath, 'utf8');

    const response = await put(routes, { apiKeys: [{ key: 'aio_agent_at_forged' }] });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

test('caller-key enforcement is switched without touching the authored keys', async () => {
  await withSettingsFixture(
    async ({ configPath, logs, routes }) => {
      // Recovering a deleted key is exactly what this switch exists to avoid, so turning
      // enforcement off must leave the array alone — and take effect without a restart.
      const response = await put(routes, { requireApiKey: false });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        restartRequired: false,
        settings: { requireApiKey: false, apiKeys: authoredConfig.server.apiKeys },
      });
      expect(onDisk(configPath).server).toMatchObject({
        requireApiKey: false,
        apiKeys: authoredConfig.server.apiKeys,
      });
      // Taking effect without a restart means the startup warning never runs, so the hot
      // switch has to raise it: a publicly bound proxy must not go open quietly.
      expect(logs.filter((entry) => entry.event === 'server.api_key_enforcement_disabled')).toEqual([
        { event: 'server.api_key_enforcement_disabled', host: '0.0.0.0' },
      ]);
    },
    { host: '0.0.0.0' },
  );
});

test('switching caller-key enforcement off on a loopback bind stays quiet', async () => {
  await withSettingsFixture(async ({ logs, routes }) => {
    expect((await put(routes, { requireApiKey: false })).status).toBe(200);

    // Unreachable from the network, so an open proxy here is the operator's own machine.
    expect(logs.some((entry) => entry.event === 'server.api_key_enforcement_disabled')).toBe(false);
  });
});

test('a config whose root parses to a non-object is refused rather than crashing the write', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    // Valid JSON, unusable as a config. This parses cleanly, so it reaches the root check rather
    // than the parser's own error — the write must still answer `config_rejected`, not a 500.
    writeFileSync(configPath, '[]');

    expect((await routes.request('/settings')).status).toBe(200);

    const before = readFileSync(configPath, 'utf8');
    const write = await put(routes, { apiKeys: [{ key: 'sk-added' }] });

    expect(write.status).toBe(422);
    expect(await write.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

test('backup credentials are masked and toggling fallback preserves both proxy addresses', async () => {
  await withSettingsFixture(async ({ routes, configPath }) => {
    const backup = 'socks5://user:backup-secret@backup.example:1080';
    const saved = await put(routes, { proxyBackup: backup });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ settings: { proxyBackup: '****', proxyFallback: false } });
    for (const enabled of [true, false]) {
      const result = await put(routes, { proxyFallback: enabled });
      expect(result.status).toBe(200);
      const text = await result.text();
      expect(text).not.toContain('backup-secret');
      expect(JSON.parse(text)).toMatchObject({ settings: { proxyBackup: '****', proxyFallback: enabled } });
      expect(onDisk(configPath).proxyBackup).toBe(backup);
      expect(onDisk(configPath).proxy).toBe(authoredConfig.proxy);
    }
  });
});

test('round-trips an authored otel destination without requiring a restart', async () => {
  await withSettingsFixture(async ({ routes, configPath }) => {
    const response = await routes.request('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        otel: {
          destinations: [
            {
              url: 'https://collector.example/v1/traces',
              contentType: 'json',
              headers: { Authorization: 'Bearer {{env.SETTINGS_OTLP_TOKEN}}' },
            },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(false);
    expect(body.settings.otel.destinations).toEqual([
      {
        url: 'https://collector.example/v1/traces',
        contentType: 'json',
        headers: { Authorization: 'Bearer {{env.SETTINGS_OTLP_TOKEN}}' },
      },
    ]);
    const stored = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(stored.server.otel.destinations[0].headers.Authorization).toBe('Bearer {{env.SETTINGS_OTLP_TOKEN}}');
    expect(stored.server.futureServer).toBe('server-preserved');
  });
});

test('a port change still requires a restart when otel is in the same request', async () => {
  await withSettingsFixture(async ({ routes }) => {
    const response = await routes.request('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        port: 9_318,
        otel: { destinations: [] },
      }),
    });
    const body = await response.json();
    expect(body.restartRequired).toBe(true);
  });
});

test('a missing otel env var is config_rejected and leaves the file unchanged', async () => {
  await withSettingsFixture(async ({ routes, configPath }) => {
    const before = readFileSync(configPath, 'utf8');
    const response = await routes.request('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        otel: {
          destinations: [
            { url: 'https://collector.example/v1/traces', headers: { Authorization: 'Bearer {{env.MISSING_OTLP}}' } },
          ],
        },
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});
