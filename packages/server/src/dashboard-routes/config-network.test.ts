import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, parseRuntimeConfig } from '@aio-proxy/core';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../dashboard-auth/test-support';
import { createDashboardRoutes } from './config';

const authoredConfig = {
  proxy: '{{env.GLOBAL_PROXY}}',
  providers: {
    api: {
      kind: 'api',
      protocol: 'openai-response',
      baseURL: '{{env.API_BASE_URL}}',
      apiKey: 'sk-preserved-value',
      proxy: '{{env.PROVIDER_PROXY}}',
      headers: { Authorization: 'Bearer {{env.UPSTREAM_TOKEN}}', 'X-Tenant': '{{env.TENANT}}' },
      models: ['gpt-test'],
      enabled: true,
    },
    sdk: {
      kind: 'ai-sdk',
      packageName: '@ai-sdk/openai-compatible',
      proxy: '{{env.SDK_PROXY}}',
      options: { name: 'sdk', apiKey: 'sk-sdk', baseURL: 'https://sdk.example' },
      models: ['sdk-model'],
      enabled: true,
    },
  },
};

async function withNetworkFixture(
  run: (routes: ReturnType<typeof createDashboardRoutes>, configPath: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-network-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(authoredConfig, null, 2));

  const previous = {
    GLOBAL_PROXY: process.env['GLOBAL_PROXY'],
    API_BASE_URL: process.env['API_BASE_URL'],
    PROVIDER_PROXY: process.env['PROVIDER_PROXY'],
    UPSTREAM_TOKEN: process.env['UPSTREAM_TOKEN'],
    TENANT: process.env['TENANT'],
    SDK_PROXY: process.env['SDK_PROXY'],
  };
  process.env['GLOBAL_PROXY'] = 'http://user:password@global.proxy:8080';
  process.env['API_BASE_URL'] = 'https://api.example/v1';
  process.env['PROVIDER_PROXY'] = 'http://user:password@provider.proxy:8080';
  process.env['UPSTREAM_TOKEN'] = 'expanded-secret';
  process.env['TENANT'] = 'expanded-tenant';
  process.env['SDK_PROXY'] = 'http://user:password@sdk.proxy:8080';

  const state = await createServerState({
    config: parseRuntimeConfig(authoredConfig),
    configPath,
    watchConfig: false,
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);

  try {
    await run(routes, configPath);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function onDisk(configPath: string) {
  return JSON.parse(readFileSync(configPath, 'utf8')) as typeof authoredConfig;
}

test('GET /config redacts proxy credentials and header values that edit-view returns in full', async () => {
  await withNetworkFixture(async (routes) => {
    const configResponse = await routes.request('/config');
    expect(configResponse.status).toBe(200);
    const configText = await configResponse.text();
    expect(configText).not.toMatch(/user:password|expanded-secret|expanded-tenant/u);
    expect(configText).toMatch(/"proxy"\s*:\s*"\*\*\*\*"/u);

    // The editor round-trips edit-view straight back through the mutation endpoint,
    // so it gets the expanded truth; only /config and the CLI mask.
    const editResponse = await routes.request('/providers/api/edit-view');
    expect(editResponse.status).toBe(200);
    const edit = (await editResponse.json()) as {
      readonly provider: { readonly proxy: string; readonly headers: Record<string, string>; readonly apiKey: string };
    };
    expect(edit.provider.proxy).toBe('http://user:password@provider.proxy:8080');
    expect(edit.provider.headers).toEqual({ Authorization: 'Bearer expanded-secret', 'X-Tenant': 'expanded-tenant' });
    expect(edit.provider.apiKey).toBe('sk-preserved-value');
  });
});

test('unrelated provider edits retain omitted headers and proxy', async () => {
  await withNetworkFixture(async (routes, configPath) => {
    const response = await routes.request('/providers/api', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'api',
        id: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example/v1',
        weight: 7,
        models: ['gpt-test'],
        enabled: true,
      }),
    });
    expect(response.status).toBe(200);

    const disk = onDisk(configPath);
    expect(disk.providers.api.proxy).toBe('{{env.PROVIDER_PROXY}}');
    expect(disk.providers.api.headers).toEqual({
      Authorization: 'Bearer {{env.UPSTREAM_TOKEN}}',
      'X-Tenant': '{{env.TENANT}}',
    });
    expect(disk.providers.api.baseURL).toBe('{{env.API_BASE_URL}}');
    expect((disk.providers.api as { weight?: number }).weight).toBe(7);
  });
});

test('an explicit null provider proxy clears the override and inherits the global proxy', async () => {
  await withNetworkFixture(async (routes, configPath) => {
    const response = await routes.request('/providers/api', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'api',
        id: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example/v1',
        proxy: null,
        models: ['gpt-test'],
        enabled: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(onDisk(configPath).providers.api).not.toHaveProperty('proxy');
  });
});

test('round-tripping the edit-view body back through PUT retains every authored template', async () => {
  await withNetworkFixture(async (routes, configPath) => {
    // The whole point of the un-masked edit-view: the editor submits the expanded
    // values it was handed straight back, and the file must keep its {{env.*}} authoring.
    const editResponse = await routes.request('/providers/api/edit-view');
    expect(editResponse.status).toBe(200);
    const { provider } = (await editResponse.json()) as { readonly provider: Record<string, unknown> };
    expect(provider['proxy']).toBe('http://user:password@provider.proxy:8080');
    expect(provider['headers']).toEqual({ Authorization: 'Bearer expanded-secret', 'X-Tenant': 'expanded-tenant' });

    const response = await routes.request('/providers/api', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider),
    });
    expect(response.status).toBe(200);

    const disk = onDisk(configPath);
    expect(disk.providers.api.proxy).toBe('{{env.PROVIDER_PROXY}}');
    expect(disk.providers.api.headers).toEqual({
      Authorization: 'Bearer {{env.UPSTREAM_TOKEN}}',
      'X-Tenant': '{{env.TENANT}}',
    });
    expect(disk.providers.api.baseURL).toBe('{{env.API_BASE_URL}}');
    expect(disk.providers.api.apiKey).toBe('sk-preserved-value');
  });
});

test('submitting the expanded baseURL retains the authored template', async () => {
  await withNetworkFixture(async (routes, configPath) => {
    const response = await routes.request('/providers/api', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'api',
        id: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example/v1',
        models: ['gpt-test'],
        enabled: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(onDisk(configPath).providers.api.baseURL).toBe('{{env.API_BASE_URL}}');
  });
});

test('malformed template or expanded SOCKS proxy returns 422 without altering the file', async () => {
  await withNetworkFixture(async (routes, configPath) => {
    const before = readFileSync(configPath, 'utf8');

    const malformed = await routes.request('/providers/api', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'api',
        id: 'api',
        protocol: 'openai-response',
        baseURL: '{{env.API_BASE_URL}}{{#if true}}x{{/if}}',
        models: ['gpt-test'],
        enabled: true,
      }),
    });
    expect(malformed.status).toBe(422);
    expect(readFileSync(configPath, 'utf8')).toBe(before);

    process.env['PROVIDER_PROXY'] = 'socks://proxy.example:1080';
    const socks = await routes.request('/providers/api', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'api',
        id: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example/v1',
        proxy: '{{env.PROVIDER_PROXY}}',
        models: ['gpt-test'],
        enabled: true,
      }),
    });
    expect(socks.status).toBe(422);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

// `metadata[model].extend` is the same round-trip hazard as `{{env.*}}`: the snapshot the editor
// reads from has already resolved it into a flat copy of the models.dev entry, so handing that copy
// back through PUT would replace a one-line inheritance with a frozen snapshot of a catalog that
// keeps moving. The editor is a round-trip surface — what it renders must be what the file says.
test('the edit-view serves metadata.extend unresolved so a round trip cannot freeze it', async () => {
  const previousHome = process.env['AIO_PROXY_HOME'];
  const home = mkdtempSync(join(tmpdir(), 'aio-extend-edit-view-'));
  const dir = mkdtempSync(join(tmpdir(), 'aio-extend-config-'));
  const configPath = join(dir, 'config.json');
  const authored = {
    providers: {
      api: {
        kind: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example/v1',
        models: ['gpt-test'],
        metadata: { 'gpt-test': { extend: 'openai/gpt-5.5', name: 'My name wins' } },
        enabled: true,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(authored, null, 2));
  process.env['AIO_PROXY_HOME'] = home;
  clearModelsCache();
  await fileCacheStorage.setItem('models-dev-providers', {
    openai: {
      models: {
        'gpt-5.5': {
          id: 'gpt-5.5',
          name: 'GPT-5.5 (catalog)',
          attachment: true,
          reasoning: true,
          tool_call: true,
          structured_output: true,
          modalities: { input: ['text'], output: ['text'] },
          open_weights: false,
          limit: { context: 400_000, input: 300_000, output: 128_000 },
          cost: { input: 1.25, output: 10 },
        },
      },
    },
  });

  const state = await createServerState({
    config: parseRuntimeConfig(authored),
    configPath,
    watchConfig: false,
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);

  try {
    // The runtime still sees the merged entry — resolution is not being turned off, only kept out
    // of the surface that writes back.
    const runtime = state.currentConfig().providers[0];
    expect(runtime?.metadata?.['gpt-test']).toMatchObject({ name: 'My name wins', cost: { input: 1.25 } });

    const editResponse = await routes.request('/providers/api/edit-view');
    expect(editResponse.status).toBe(200);
    const { provider } = (await editResponse.json()) as { readonly provider: Record<string, unknown> };
    expect(provider['metadata']).toEqual({ 'gpt-test': { extend: 'openai/gpt-5.5', name: 'My name wins' } });

    const response = await routes.request('/providers/api', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).providers.api.metadata).toEqual({
      'gpt-test': { extend: 'openai/gpt-5.5', name: 'My name wins' },
    });
  } finally {
    state.close();
    clearModelsCache();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env['AIO_PROXY_HOME'];
    else process.env['AIO_PROXY_HOME'] = previousHome;
  }
});
