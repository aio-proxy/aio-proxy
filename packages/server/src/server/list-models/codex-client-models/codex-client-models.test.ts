import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage } from '@aio-proxy/core';
import { ProviderKind } from '@aio-proxy/types';
import type { Model, ProviderMap } from '@opencode-ai/models';

import type { RuntimeProviderInstance } from '../../../runtime';
import type { ServerState } from '../../../server-state';
import { codexClientModels } from './codex-client-models';

const provider = {
  id: 'p1',
  kind: ProviderKind.OAuth,
  enabled: true,
  alias: {
    'gpt-5': { model: 'gpt-5.6-sol', preserve: false },
    'my-alias': { model: 'third-party-model', preserve: false },
  },
  metadata: {},
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

function fakeState(): ServerState {
  return {
    acquireProviderSnapshot: () => ({ snapshot: { providers: [provider] }, release() {} }),
  } as unknown as ServerState;
}

const upstream = {
  slug: 'gpt-5.6-sol',
  display_name: 'GPT-5.6-Sol',
  priority: 1,
  supported_in_api: true,
  visibility: 'list',
  base_instructions: 'UPSTREAM VERBATIM',
  availability_nux: { message: 'keep me' },
};

const model = (id: string, name: string): Model => ({
  attachment: false,
  description: '',
  id,
  last_updated: '2026-01-15',
  limit: { context: 128_000, output: 8_000 },
  modalities: { input: ['text'], output: ['text'] },
  name,
  open_weights: false,
  reasoning: false,
  release_date: '2026-01-15',
  tool_call: false,
});

const providerMap: ProviderMap = {
  openai: {
    doc: 'https://example.com/openai',
    env: [],
    id: 'openai',
    models: { 'gpt-5': model('gpt-5', 'GPT-5') },
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
  },
  openrouter: {
    doc: 'https://example.com/openrouter',
    env: [],
    id: 'openrouter',
    models: {
      apple: model('apple', 'Apple'),
      'my-alias': model('my-alias', 'My Alias'),
      zebra: model('zebra', 'Zebra'),
    },
    name: 'OpenRouter',
    npm: '@openrouter/ai-sdk-provider',
  },
};

const original = process.env.AIO_PROXY_HOME;
let home: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'codex-client-models-'));
  process.env.AIO_PROXY_HOME = home;
  clearModelsCache();
  await fileCacheStorage.setItem('models-dev-providers', providerMap);
});

afterEach(() => {
  clearModelsCache();
  rmSync(home, { recursive: true, force: true });
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

test('case A returns upstream verbatim with alias slug/id; case B synthesizes without availability_nux', async () => {
  const fetchImpl = (async () => Response.json({ models: [upstream] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const caseA = models.find((m) => m.id === 'gpt-5');
  expect(caseA).toBeDefined();
  const caseAEntry = caseA as Record<string, unknown>;
  expect(caseAEntry.slug).toBe('gpt-5');
  expect(caseAEntry.base_instructions).toBe('UPSTREAM VERBATIM');
  expect(caseAEntry.availability_nux).toEqual({ message: 'keep me' });

  const caseB = models.find((m) => m.id === 'my-alias');
  expect(caseB).toBeDefined();
  const caseBEntry = caseB as Record<string, unknown>;
  expect(caseBEntry.slug).toBe('my-alias');
  expect(caseBEntry.display_name).toBe('My Alias');
  expect('availability_nux' in caseBEntry).toBe(false);
  expect((caseBEntry.base_instructions as string).includes('based on my-alias.')).toBe(true);
});

test('synthesized entries get deterministic priorities past the max template priority, ordered by display name', async () => {
  const multi = {
    id: 'p1',
    kind: ProviderKind.OAuth,
    enabled: true,
    alias: {
      'gpt-5': { model: 'gpt-5.6-sol', preserve: false },
      zebra: { model: 'third-party-z', preserve: false },
      apple: { model: 'third-party-a', preserve: false },
    },
    metadata: {},
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;
  const state = {
    acquireProviderSnapshot: () => ({ snapshot: { providers: [multi] }, release() {} }),
  } as unknown as ServerState;

  // Template gpt-5.6-sol has priority 1; synthesized entries must sort after it
  // and be spaced 100 apart in display-name order (apple before zebra).
  const fetchImpl = (async () => Response.json({ models: [{ ...upstream, priority: 1 }] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(state, { fetchImpl });

  const bySlug = new Map(models.map((m) => [m.slug as string, m]));
  expect(bySlug.get('gpt-5')?.priority).toBe(1);
  expect(bySlug.get('apple')?.priority).toBe(101);
  expect(bySlug.get('zebra')?.priority).toBe(201);
  // Response is ordered by ascending priority.
  expect(models.map((m) => m.slug)).toEqual(['gpt-5', 'apple', 'zebra']);
});
