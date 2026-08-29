import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { clearModelsDevCatalog, modelsDevModel, seedModelsDevCatalog } from '../../__tests__/server.test-support';
import { disabledDashboardAuthentication } from '../dashboard-auth/test-support';
import { createDashboardRoutes } from './config';

afterEach(() => {
  clearModelsDevCatalog();
});

test('GET /models-dev/lookup returns the fallback slug and metadata from the cached catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-models-dev-lookup-'));
  await seedModelsDevCatalog({
    'gpt-5': modelsDevModel('gpt-5', 'GPT-5', { description: 'A capable model.' }),
  });
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    dbHome: dir,
  });

  try {
    const routes = createDashboardRoutes(state, disabledDashboardAuthentication);
    const miss = await routes.request('/models-dev/lookup?id=');
    expect(miss.status).toBe(400);

    const hit = await routes.request('/models-dev/lookup?id=gpt-5');
    expect(hit.status).toBe(200);
    expect(await hit.json()).toMatchObject({
      slug: 'openai/gpt-5',
      metadata: { name: 'GPT-5', limit: { context: 128_000 } },
    });

    const unknown = await routes.request('/models-dev/lookup?id=missing');
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ slug: null, metadata: null });
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
