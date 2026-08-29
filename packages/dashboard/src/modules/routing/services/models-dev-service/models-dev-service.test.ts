import { beforeEach, describe, expect, rs, test } from '@rstest/core';

import { fetchModelsDevLookup, fetchModelsDevSlugs } from './models-dev-service';

const mocks = rs.hoisted(() => ({ slugsGet: rs.fn(), lookupGet: rs.fn() }));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: { api: { 'models-dev': { slugs: { $get: mocks.slugsGet }, lookup: { $get: mocks.lookupGet } } } },
  },
}));

describe('fetchModelsDevSlugs', () => {
  beforeEach(() => mocks.slugsGet.mockReset());

  test('treats a non-2xx response as a failure even when the body is JSON', async () => {
    mocks.slugsGet.mockResolvedValue(
      new Response(JSON.stringify({ slugs: [] }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(fetchModelsDevSlugs()).rejects.toThrow();
  });

  test('returns the JSON body of a 2xx response', async () => {
    mocks.slugsGet.mockResolvedValue(Response.json({ slugs: ['openai/gpt-5'] }));

    await expect(fetchModelsDevSlugs()).resolves.toEqual({ slugs: ['openai/gpt-5'] });
  });
});

describe('fetchModelsDevLookup', () => {
  beforeEach(() => mocks.lookupGet.mockReset());

  test('treats a non-2xx response as a failure even when the body is JSON', async () => {
    mocks.lookupGet.mockResolvedValue(
      new Response(JSON.stringify({ slug: null, metadata: null }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(fetchModelsDevLookup('gpt-5')).rejects.toThrow();
  });

  test('returns the JSON body of a 2xx response', async () => {
    mocks.lookupGet.mockResolvedValue(Response.json({ slug: 'openai/gpt-5', metadata: { name: 'GPT-5' } }));

    await expect(fetchModelsDevLookup('gpt-5')).resolves.toEqual({ slug: 'openai/gpt-5', metadata: { name: 'GPT-5' } });
  });
});
