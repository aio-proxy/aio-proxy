import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentCatalogV1, AgentManagedMarker, AgentManagedStateV1 } from '@aio-proxy/types';

import { writeManagedState } from './managed-state';

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

test('atomic state failure leaves the prior bytes and successful replacement is private', async () => {
  const f = runtimeFixture({ lkg: CATALOG });
  const before = await Bun.file(f.statePath).bytes();
  await expect(
    writeManagedState(f.statePath, freshState(CATALOG, 2_000), {
      rename: async () => {
        throw new Error('injected rename failure');
      },
    }),
  ).rejects.toThrow('injected rename failure');
  expect(await Bun.file(f.statePath).bytes()).toEqual(before);
  await writeManagedState(f.statePath, freshState(CATALOG, 2_000));
  expect((await stat(f.statePath)).mode & 0o777).toBe(0o600);
});
