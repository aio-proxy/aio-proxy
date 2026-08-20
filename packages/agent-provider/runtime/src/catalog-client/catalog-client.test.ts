import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentCatalogV1, AgentManagedMarker, AgentManagedStateV1 } from '@aio-proxy/types';

import { refreshAgentCatalog } from './catalog-client';

const CATALOG: AgentCatalogV1 = {
  schema_version: 1,
  agent: 'opencode',
  models: [
    {
      id: 'compat-model',
      name: 'Compat Model',
      reasoning: false,
      tool_call: true,
      temperature: false,
      attachment: false,
      input: ['text'],
      context_window: 8_192,
      max_output_tokens: 2_048,
    },
  ],
};
const RUNTIME_MARKER = {
  format: 1,
  managedBy: 'aio-proxy',
  agent: 'opencode',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3',
  endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;
const runtimeRoots: string[] = [];

afterEach(() => {
  for (const root of runtimeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const freshState = (lkg: AgentCatalogV1, now: number): AgentManagedStateV1 => ({
  format: 1,
  catalogSchema: 1,
  status: 'fresh',
  lastSuccessfulAt: new Date(now).toISOString(),
  lastError: null,
  lkg,
});

function runtimeFixture(options: { readonly lkg?: AgentCatalogV1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-runtime-'));
  runtimeRoots.push(root);
  const statePath = join(root, '.aio-proxy-state.json');
  if (options.lkg !== undefined) {
    writeFileSync(statePath, JSON.stringify(freshState(options.lkg, 1_000)), { mode: 0o600 });
  }
  return {
    statePath,
    input: { marker: RUNTIME_MARKER, statePath, accessToken: 'agent-access' },
    readState: (): AgentManagedStateV1 => JSON.parse(readFileSync(statePath, 'utf8')),
  };
}

test('catalog success validates before atomically replacing LKG', async () => {
  const f = runtimeFixture();
  const result = await refreshAgentCatalog({ ...f.input, fetch: async () => Response.json(CATALOG) });
  expect(result).toEqual({ catalog: CATALOG, source: 'network', status: 'fresh' });
  expect(JSON.parse(await Bun.file(f.statePath).text())).toMatchObject({ status: 'fresh', lastError: null });
});

test('401 never retries anonymously and never overwrites LKG', async () => {
  const f = runtimeFixture({ lkg: CATALOG });
  const calls: Headers[] = [];
  const result = await refreshAgentCatalog({
    ...f.input,
    fetch: async (_url, init) => {
      calls.push(new Headers(init?.headers));
      return new Response('', { status: 401 });
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.get('authorization')).toBe('Bearer agent-access');
  expect(result).toMatchObject({ catalog: CATALOG, source: 'lkg', status: 'stale', error: 'unauthorized' });
});

test.each([
  ['malformed json', async () => new Response('{', { status: 200 }), 'invalid_json'],
  ['server failure', async () => new Response('', { status: 503 }), 'server_error'],
  [
    'network failure',
    async () => {
      throw new TypeError('offline');
    },
    'network',
  ],
] as const)('%s preserves LKG', async (_name, fetch, error) => {
  const f = runtimeFixture({ lkg: CATALOG });
  expect(await refreshAgentCatalog({ ...f.input, fetch })).toMatchObject({
    catalog: CATALOG,
    source: 'lkg',
    status: 'stale',
    error,
  });
});

test('a real 400 unsupported-schema body has its stable category and preserves LKG', async () => {
  const f = runtimeFixture({ lkg: CATALOG });
  const result = await refreshAgentCatalog({
    ...f.input,
    fetch: async () =>
      Response.json(
        {
          error: { code: 'unsupported_schema', message: 'Catalog schema 1 is not supported.' },
          supported_schema_versions: [2],
        },
        { status: 400 },
      ),
  });
  expect(result).toMatchObject({
    catalog: CATALOG,
    source: 'lkg',
    status: 'stale',
    error: 'unsupported_schema',
  });
  expect(f.readState().lkg).toEqual(CATALOG);
});

test('wrong target never replaces state', async () => {
  const f = runtimeFixture({ lkg: CATALOG });
  await refreshAgentCatalog({ ...f.input, fetch: async () => Response.json({ ...CATALOG, agent: 'pi' }) });
  expect(f.readState().lkg).toEqual(CATALOG);
});

test('missing LKG remains missing after a failed refresh', async () => {
  const f = runtimeFixture();
  expect(await refreshAgentCatalog({ ...f.input, fetch: async () => new Response('', { status: 503 }) })).toEqual({
    catalog: null,
    source: 'missing',
    status: 'missing',
    error: 'server_error',
  });
});
