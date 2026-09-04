import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRuntimeConfig, Router } from '@aio-proxy/core';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createDashboardRoutes } from '../config';

const authoredConfig = { plugins: [], providers: {}, router: {}, server: { port: 9_317 } };

type Routes = ReturnType<typeof createDashboardRoutes>;

async function withReloadFixture(
  run: (fixture: { readonly configPath: string; readonly routes: Routes }) => Promise<void>,
  options: { readonly rejectReload?: { value: boolean } } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'aio-dashboard-reload-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(authoredConfig, null, 2));
  const rejectReload = options.rejectReload;
  const state = await createServerState({
    config: parseRuntimeConfig(authoredConfig),
    configPath,
    dbHome: directory,
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
    await run({ configPath, routes: createDashboardRoutes(state, disabledDashboardAuthentication) });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

const reload = (routes: Routes): Promise<Response> => routes.request('/reload', { method: 'POST' });

test('POST /reload re-reads the config file and reports the provider diff', async () => {
  await withReloadFixture(async ({ configPath, routes }) => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          ...authoredConfig,
          providers: {
            added: { kind: 'api', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', apiKey: 'sk-test' },
          },
        },
        null,
        2,
      ),
    );

    const response = await reload(routes);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, diff: { providerIds: { added: ['added'], removed: [] } } });
  });
});

test('POST /reload reports the failing stage without applying the snapshot', async () => {
  const rejectReload = { value: false };
  await withReloadFixture(
    async ({ routes }) => {
      rejectReload.value = true;

      const response = await reload(routes);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, stage: 'providers' });
    },
    { rejectReload },
  );
});
