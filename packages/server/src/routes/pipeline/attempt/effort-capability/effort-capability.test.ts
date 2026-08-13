import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import {
  clearModelsDevCatalog,
  modelsDevModel,
  seedEmptyModelsDevCatalog,
  seedModelsDevCatalog,
} from '../../../../../__tests__/server.test-support';
import * as capability from './effort-capability';
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
    const spy = spyOn(capability, 'resolveSupportedEfforts');
    try {
      const result = await capability.resolveSupportedEffortsForDimensions({}, 'gpt-effort');
      expect(result.size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
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
