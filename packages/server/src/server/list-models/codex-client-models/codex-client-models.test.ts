import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, Router } from '@aio-proxy/core';
import {
  ModelContextAggregation,
  ProviderKind,
  type RouterModelPolicy,
  RouterModelPolicySchema,
} from '@aio-proxy/types';
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
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

function fakeState(
  providers: readonly RuntimeProviderInstance[] = [provider],
  aggregation?: (typeof ModelContextAggregation)[keyof typeof ModelContextAggregation],
  models: Readonly<Record<string, RouterModelPolicy>> = {},
): ServerState {
  const normalizedModels = Object.fromEntries(
    Object.entries(models).map(([slug, policy]) => [slug, RouterModelPolicySchema.parse(policy)]),
  );
  const config = {
    router: {
      ...(aggregation === undefined ? {} : { modelContextAggregation: aggregation }),
      models: normalizedModels,
    },
  };
  return {
    acquireProviderSnapshot: () => ({
      snapshot: {
        providers,
        router: new Router(providers, { models: normalizedModels }),
        config,
      },
      release() {},
    }),
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

const model = (id: string, name: string, overrides: Partial<Model> = {}): Model => ({
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
  ...overrides,
});

const providerMap: ProviderMap = {
  openai: {
    doc: 'https://example.com/openai',
    env: [],
    id: 'openai',
    models: {
      'gpt-5': model('gpt-5', 'GPT-5', {
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      }),
    },
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

test('official Codex windows beat larger models.dev fallback limits', async () => {
  const officialRow = { ...upstream, context_window: 272_000, max_context_window: 272_000 };
  const fetchImpl = (async () => Response.json({ models: [officialRow] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const official = models.find((entry) => entry.id === 'gpt-5') as Record<string, unknown>;
  expect(official.context_window).toBe(272_000);
  expect(official.max_context_window).toBe(272_000);
});

test('configured generic limits override official Codex windows as a distinct pair', async () => {
  const officialRow = { ...upstream, context_window: 272_000, max_context_window: 272_000 };
  const fetchImpl = (async () => Response.json({ models: [officialRow] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(
    fakeState([provider], undefined, {
      'gpt-5': { metadata: { limit: { context: 1_050_000, input: 922_000, output: 128_000 } } },
    }),
    { fetchImpl },
  );

  const official = models.find((entry) => entry.id === 'gpt-5') as Record<string, unknown>;
  expect(official.context_window).toBe(922_000);
  expect(official.max_context_window).toBe(1_050_000);
});

test('configured composite limits win in both matching-row case A and synthesized case B', async () => {
  const configured = {
    id: 'p1',
    kind: ProviderKind.OAuth,
    enabled: true,
    alias: {
      'gpt-5': { model: 'gpt-5.6-sol', preserve: false },
      'my-alias': { model: 'third-party-model', preserve: false },
    },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;

  const upstreamRow = { ...upstream, context_window: 272_000, max_context_window: 272_000 };
  const fetchImpl = (async () => Response.json({ models: [upstreamRow] })) as unknown as typeof fetch;
  const policy = { metadata: { limit: { context: 400_000, input: 272_000, output: 128_000 } } };
  const { models } = await codexClientModels(
    fakeState([configured], undefined, { 'gpt-5': policy, 'my-alias': policy }),
    { fetchImpl },
  );

  const caseA = models.find((m) => m.id === 'gpt-5') as Record<string, unknown>;
  expect(caseA.context_window).toBe(272_000);
  expect(caseA.max_context_window).toBe(400_000);

  const caseB = models.find((m) => m.id === 'my-alias') as Record<string, unknown>;
  expect(caseB.context_window).toBe(272_000);
  expect(caseB.max_context_window).toBe(400_000);
});

test('case A applies mapped config fields without dropping official-only fields', async () => {
  const models = {
    'gpt-5': {
      metadata: {
        name: 'Configured Name',
        description: 'Configured description',
        capabilities: {
          modalities: { input: ['text'] },
          reasoning: true,
          reasoningOptions: [{ type: 'effort', values: ['high', 'max'] }],
        },
      },
    },
  };
  const officialRow = {
    ...upstream,
    display_name: 'Official Name',
    description: 'Official description',
    context_window: 272_000,
    max_context_window: 272_000,
    input_modalities: ['text', 'image'],
    supported_reasoning_levels: [{ effort: 'low', description: 'official' }],
    default_reasoning_level: 'low',
    service_tiers: [{ name: 'priority' }],
  };
  const fetchImpl = (async () => Response.json({ models: [officialRow] })) as unknown as typeof fetch;
  const result = await codexClientModels(fakeState([provider], undefined, models), { fetchImpl });

  const entry = result.models.find((item) => item.id === 'gpt-5') as Record<string, unknown>;
  expect(entry.display_name).toBe('Configured Name');
  expect(entry.description).toBe('Configured description');
  expect(entry.input_modalities).toEqual(['text']);
  expect((entry.supported_reasoning_levels as { effort: string }[]).map(({ effort }) => effort)).toEqual([
    'high',
    'max',
  ]);
  expect(entry.default_reasoning_level).toBe('high');
  expect(entry.availability_nux).toEqual({ message: 'keep me' });
  expect(entry.base_instructions).toBe('UPSTREAM VERBATIM');
  expect(entry.service_tiers).toEqual([{ name: 'priority' }]);
});

test('a config reasoning flag without effort values leaves official reasoning levels intact', async () => {
  const officialRow = {
    ...upstream,
    supported_reasoning_levels: [{ effort: 'high', description: 'official' }],
    default_reasoning_level: 'high',
  };
  const fetchImpl = (async () => Response.json({ models: [officialRow] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(
    fakeState([provider], undefined, {
      'gpt-5': { metadata: { capabilities: { reasoning: true } } },
    }),
    { fetchImpl },
  );

  const entry = models.find((item) => item.id === 'gpt-5') as Record<string, unknown>;
  expect(entry.supported_reasoning_levels).toEqual([{ effort: 'high', description: 'official' }]);
  expect(entry.default_reasoning_level).toBe('high');
});

test.each([
  ['non-positive', { context_window: 0, max_context_window: -1 }],
  ['non-integer', { context_window: 272_000.5, max_context_window: 400_000 }],
  ['reversed', { context_window: 400_000, max_context_window: 272_000 }],
])('ignores %s official windows and resolves a valid fallback pair', async (_label, invalidWindows) => {
  const fetchImpl = (async () =>
    Response.json({ models: [{ ...upstream, ...invalidWindows }] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const entry = models.find((item) => item.id === 'gpt-5') as Record<string, unknown>;
  expect(entry.context_window).toBe(922_000);
  expect(entry.max_context_window).toBe(1_050_000);
});

test('falls back to static valid windows when official and models.dev windows are unavailable', async () => {
  await fileCacheStorage.setItem('models-dev-providers', {
    ...providerMap,
    openai: { ...providerMap.openai, models: {} },
    openrouter: { ...providerMap.openrouter, models: {} },
  });
  clearModelsCache();
  const invalidRow = { ...upstream, context_window: 400_000, max_context_window: 272_000 };
  const fetchImpl = (async () => Response.json({ models: [invalidRow] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const entry = models.find((item) => item.id === 'gpt-5') as Record<string, unknown>;
  expect(entry.context_window).toBe(272_000);
  expect(entry.max_context_window).toBe(272_000);
});

test('an empty models.dev map leaves a valid official Codex pair unchanged', async () => {
  await fileCacheStorage.setItem('models-dev-providers', {
    ...providerMap,
    openai: { ...providerMap.openai, models: {} },
    openrouter: { ...providerMap.openrouter, models: {} },
  });
  clearModelsCache();
  const officialRow = { ...upstream, context_window: 272_000, max_context_window: 400_000 };
  const fetchImpl = (async () => Response.json({ models: [officialRow] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const entry = models.find((item) => item.id === 'gpt-5') as Record<string, unknown>;
  expect(entry.context_window).toBe(272_000);
  expect(entry.max_context_window).toBe(400_000);
});

test('aggregates candidate windows only after each candidate resolves its own sources', async () => {
  const configured = {
    id: 'configured',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { shared: { model: 'configured-model', preserve: false } },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;
  const official = {
    id: 'official',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { shared: { model: 'official-model', preserve: false } },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;
  const officialRow = {
    ...upstream,
    slug: 'official-model',
    context_window: 300_000,
    max_context_window: 500_000,
  };
  const fetchImpl = (async () => Response.json({ models: [officialRow] })) as unknown as typeof fetch;
  const models = {
    shared: {
      providers: {
        configured: { limit: { context: 400_000, input: 272_000, output: 128_000 } },
      },
    },
  };

  const min = await codexClientModels(fakeState([configured, official], ModelContextAggregation.Min, models), {
    fetchImpl,
  });
  const max = await codexClientModels(fakeState([configured, official], ModelContextAggregation.Max, models), {
    fetchImpl,
  });
  const minEntry = min.models.find((item) => item.id === 'shared') as Record<string, unknown>;
  const maxEntry = max.models.find((item) => item.id === 'shared') as Record<string, unknown>;
  expect([minEntry.context_window, minEntry.max_context_window]).toEqual([272_000, 400_000]);
  expect([maxEntry.context_window, maxEntry.max_context_window]).toEqual([300_000, 500_000]);
});

test('router metadata overrides flow into the synthesized case B entry', async () => {
  // Router metadata overrides the public model's description and input modalities.
  // The synthesized entry must reflect metadata projected on demand from router policy and
  // fallback sources, not the raw catalog record, so these overrides surface to Codex.
  const configured = {
    id: 'p1',
    kind: ProviderKind.OAuth,
    enabled: true,
    alias: {
      'my-alias': { model: 'my-alias', preserve: false },
    },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;

  const fetchImpl = (async () => Response.json({ models: [upstream] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(
    fakeState([configured], undefined, {
      'my-alias': {
        metadata: {
          description: 'Overridden by config',
          capabilities: { modalities: { input: ['text', 'image'] } },
        },
      },
    }),
    { fetchImpl },
  );

  const caseB = models.find((m) => m.id === 'my-alias') as Record<string, unknown>;
  expect(caseB.description).toBe('Overridden by config');
  expect(caseB.input_modalities).toEqual(['text', 'image']);
});

test('case A backfills base_instructions from model_messages.instructions_template when the row omits it', async () => {
  // Codex client 0.146.0 requires ModelInfo.base_instructions; upstream gpt-5.6-*
  // rows omit it and carry the prompt under model_messages.instructions_template.
  // The emitted row must still expose a non-empty base_instructions or the client
  // rejects the whole catalog and shows an empty picker.
  const { base_instructions: _dropped, ...withoutBase } = upstream;
  const rowWithTemplate = {
    ...withoutBase,
    model_messages: { instructions_template: 'TEMPLATE PROMPT', instructions_variables: {}, approvals: null },
  };
  const fetchImpl = (async () => Response.json({ models: [rowWithTemplate] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const caseA = models.find((m) => m.id === 'gpt-5') as Record<string, unknown>;
  expect(caseA.base_instructions).toBe('TEMPLATE PROMPT');
});

test('case A falls back to the bundled template when the row has neither base_instructions nor instructions_template', async () => {
  const { base_instructions: _dropped, ...withoutBase } = upstream;
  const fetchImpl = (async () => Response.json({ models: [withoutBase] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const caseA = models.find((m) => m.id === 'gpt-5') as Record<string, unknown>;
  expect((caseA.base_instructions as string).includes('based on gpt-5.')).toBe(true);
});

test('case A leaves an absent instructions_template absent (client falls back to base_instructions)', async () => {
  // A missing Option key deserializes to None, so the client falls back to
  // base_instructions. We must not fabricate a template that would then be
  // preferred over the real base prompt.
  const rowWithoutMessages = { ...upstream, base_instructions: 'REAL BASE' };
  const fetchImpl = (async () => Response.json({ models: [rowWithoutMessages] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const caseA = models.find((m) => m.id === 'gpt-5') as Record<string, unknown>;
  expect(caseA.base_instructions).toBe('REAL BASE');
  expect('model_messages' in caseA).toBe(false);
});

test('case A rewrites an empty instructions_template so the client does not read an empty prompt', async () => {
  // The client prefers instructions_template whenever the key is present, even
  // when empty. A present-but-empty template must be replaced, and here there is
  // no base_instructions, so both fields fall back to the bundled template.
  const { base_instructions: _dropped, ...withoutBase } = upstream;
  const rowWithEmptyTemplate = {
    ...withoutBase,
    model_messages: { instructions_template: '', instructions_variables: {}, approvals: null },
  };
  const fetchImpl = (async () => Response.json({ models: [rowWithEmptyTemplate] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const caseA = models.find((m) => m.id === 'gpt-5') as Record<string, unknown>;
  const rendered = caseA.base_instructions as string;
  expect(rendered.includes('based on gpt-5.')).toBe(true);
  expect((caseA.model_messages as { instructions_template: string }).instructions_template).toBe(rendered);
});

test('case A prefers a non-empty instructions_template over base_instructions for the required field', async () => {
  // When the client will use the template at runtime, base_instructions must be
  // seeded from that same template so the deserialization-required field matches
  // the effective prompt.
  const rowWithBoth = {
    ...upstream,
    base_instructions: 'STALE BASE',
    model_messages: { instructions_template: 'LIVE TEMPLATE', instructions_variables: {}, approvals: null },
  };
  const fetchImpl = (async () => Response.json({ models: [rowWithBoth] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const caseA = models.find((m) => m.id === 'gpt-5') as Record<string, unknown>;
  expect(caseA.base_instructions).toBe('LIVE TEMPLATE');
  expect((caseA.model_messages as { instructions_template: string }).instructions_template).toBe('LIVE TEMPLATE');
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

  // Template gpt-5.6-sol has priority 1; synthesized entries must sort after it
  // and be spaced 100 apart in display-name order (apple before zebra).
  const fetchImpl = (async () => Response.json({ models: [{ ...upstream, priority: 1 }] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState([multi]), { fetchImpl });

  const bySlug = new Map(models.map((m) => [m.slug as string, m]));
  expect(bySlug.get('gpt-5')?.priority).toBe(1);
  expect(bySlug.get('apple')?.priority).toBe(101);
  expect(bySlug.get('zebra')?.priority).toBe(201);
  // Response is ordered by ascending priority.
  expect(models.map((m) => m.slug)).toEqual(['gpt-5', 'apple', 'zebra']);
});
