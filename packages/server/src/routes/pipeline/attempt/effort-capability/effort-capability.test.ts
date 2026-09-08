import { afterEach, describe, expect, test } from 'bun:test';

import {
  clearModelsDevCatalog,
  modelsDevModel,
  seedEmptyModelsDevCatalog,
  seedModelsDevCatalog,
} from '../../../../../__tests__/server.test-support';
import { resolveSupportedEfforts, resolveSupportedEffortsForDimensions } from './effort-capability';

// Seed an isolated, empty catalog so the lookup resolves offline instead of
// reaching models.dev — the empty-set pass-through contract is what matters here.
afterEach(clearModelsDevCatalog);

describe('resolveSupportedEfforts', () => {
  test('returns an empty set for an unknown model (no throw)', async () => {
    await seedEmptyModelsDevCatalog();
    const result = await resolveSupportedEfforts('definitely-not-a-real-model-xyz');
    expect(result.size).toBe(0);
  });

  test('reads advertised effort levels from a cached catalog', async () => {
    await seedModelsDevCatalog({
      'gpt-effort': modelsDevModel('gpt-effort', 'GPT Effort', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      }),
    });
    const result = await resolveSupportedEfforts('gpt-effort');
    expect([...result].sort()).toEqual(['high', 'low', 'medium']);
  });

  test('does not fetch the catalog over the network on the hot path', async () => {
    // Even with only an empty (or absent) cached provider map, the cached-only
    // lookup must never reach out to models.dev — a network fetch here would
    // block the request. It returns an empty set instead.
    await seedEmptyModelsDevCatalog();
    const originalFetch = globalThis.fetch;
    let fetchedCatalog = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://models.dev/api.json') fetchedCatalog = true;
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const result = await resolveSupportedEfforts('some-uncached-model');
      expect(result.size).toBe(0);
      expect(fetchedCatalog).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('resolveSupportedEffortsForDimensions', () => {
  test('skips catalog lookup when effort is omitted', async () => {
    // Seed a catalog where the model DOES advertise efforts: if the
    // effort-undefined short-circuit were removed, the lookup would leak
    // through and return a non-empty set, failing this assertion.
    await seedModelsDevCatalog({
      'gpt-effort': modelsDevModel('gpt-effort', 'GPT Effort', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      }),
    });
    const result = await resolveSupportedEffortsForDimensions({}, 'gpt-effort');
    expect(result.size).toBe(0);
  });

  test('looks up capabilities when effort is present', async () => {
    await seedModelsDevCatalog({
      'gpt-effort': modelsDevModel('gpt-effort', 'GPT Effort', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      }),
    });
    const result = await resolveSupportedEffortsForDimensions({ effort: 'high' }, 'gpt-effort');
    expect([...result].sort()).toEqual(['high', 'low', 'medium']);
  });
});

describe('runtime provider metadata precedence', () => {
  test('prefers the runtime provider capabilities over models.dev', async () => {
    await seedModelsDevCatalog({
      'claude-opus-4-6-thinking': modelsDevModel('claude-opus-4-6-thinking', 'Opus', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
      }),
    });
    const result = await resolveSupportedEfforts('claude-opus-4-6-thinking', {
      capabilities: { reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'max'] }] },
    });
    expect([...result].sort()).toEqual(['high', 'low', 'max', 'medium']);
  });

  test('falls back to models.dev when the runtime metadata advertises no effort option', async () => {
    await seedModelsDevCatalog({
      'gpt-effort': modelsDevModel('gpt-effort', 'GPT Effort', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      }),
    });
    expect([...(await resolveSupportedEfforts('gpt-effort', { capabilities: { reasoning: true } }))].sort()).toEqual([
      'high',
      'low',
    ]);
    expect([...(await resolveSupportedEfforts('gpt-effort', undefined))].sort()).toEqual(['high', 'low']);
  });

  test('drops null and default placeholders from advertised values', async () => {
    await seedEmptyModelsDevCatalog();
    const result = await resolveSupportedEfforts('wire-model', {
      capabilities: { reasoningOptions: [{ type: 'effort', values: [null, 'default', 'low', 'high'] }] },
    });
    expect([...result].sort()).toEqual(['high', 'low']);
  });

  test('an empty runtime effort list falls back rather than disabling clamping', async () => {
    await seedModelsDevCatalog({
      'gpt-effort': modelsDevModel('gpt-effort', 'GPT Effort', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low'] }],
      }),
    });
    const result = await resolveSupportedEfforts('gpt-effort', {
      capabilities: { reasoningOptions: [{ type: 'effort', values: [] }] },
    });
    expect([...result]).toEqual(['low']);
  });

  test('forDimensions passes runtime metadata through and still skips when effort is absent', async () => {
    await seedEmptyModelsDevCatalog();
    const metadata = { capabilities: { reasoningOptions: [{ type: 'effort' as const, values: ['low', 'high'] }] } };
    expect((await resolveSupportedEffortsForDimensions({}, 'wire-model', metadata)).size).toBe(0);
    expect([...(await resolveSupportedEffortsForDimensions({ effort: 'max' }, 'wire-model', metadata))].sort()).toEqual(
      ['high', 'low'],
    );
  });
});
