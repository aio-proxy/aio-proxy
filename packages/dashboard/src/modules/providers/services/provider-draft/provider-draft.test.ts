import { ProviderProtocol } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';

import { fetchProviderDraftCatalog, testProviderDraftModel } from './provider-draft';

const mocks = rs.hoisted(() => ({ catalog: rs.fn(), test: rs.fn() }));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: {
      api: {
        providers: {
          draft: {
            catalog: { $query: mocks.catalog },
            test: { $post: mocks.test },
          },
        },
      },
    },
  },
}));

const draft = {
  baseURL: 'https://api.example/v1',
  id: 'draft-provider',
  kind: 'api' as const,
  models: ['model-a'],
  protocol: ProviderProtocol.OpenAICompatible,
};

describe('Provider draft service', () => {
  beforeEach(() => {
    mocks.catalog.mockReset();
    mocks.test.mockReset();
  });

  test('sends the unsaved draft to the typed catalog route', async () => {
    mocks.catalog.mockResolvedValue(Response.json({ ok: true, models: ['model-a'] }));

    await expect(fetchProviderDraftCatalog({ draft })).resolves.toEqual({ ok: true, models: ['model-a'] });
    expect(mocks.catalog).toHaveBeenCalledWith({ json: { draft } });
  });

  test('returns a recoverable catalog failure instead of throwing a submit-blocking error', async () => {
    const failure = { ok: false, error: { code: 'catalog_unavailable', recoverable: true } } as const;
    mocks.catalog.mockResolvedValue(Response.json(failure));

    await expect(fetchProviderDraftCatalog({ draft })).resolves.toEqual(failure);
  });

  test('sends the selected enabled model and optional persisted Provider ID to the test route', async () => {
    mocks.test.mockResolvedValue(Response.json({ ok: true }));

    await expect(
      testProviderDraftModel({ draft, model: 'model-a', persistedProviderId: 'draft-provider' }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.test).toHaveBeenCalledWith({
      json: { draft, model: 'model-a', persistedProviderId: 'draft-provider' },
    });
  });

  test('returns a failed validation aid without throwing', async () => {
    const failure = { ok: false, error: { code: 'test_request_failed', recoverable: true } } as const;
    mocks.test.mockResolvedValue(Response.json(failure));

    await expect(testProviderDraftModel({ draft, model: 'model-a' })).resolves.toEqual(failure);
  });
});
