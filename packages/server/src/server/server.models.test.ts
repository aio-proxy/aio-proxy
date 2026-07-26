import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createBaseServer } from '@aio-proxy/server';

import { config, noModelsDevCatalog } from '../../__tests__/server.test-support';
import { loopbackServer } from '../dashboard-auth/test-support';

describe('GET /v1/models client_version routing', () => {
  let dir: string;
  let tmpAioHome: string;
  let originalAioHome: string | undefined;

  const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
    createBaseServer({ ...options, dbHome: dir, modelsDevCatalogTask: noModelsDevCatalog });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aio-proxy-server-'));
    tmpAioHome = mkdtempSync(join(tmpdir(), 'aio-proxy-home-'));
    originalAioHome = process.env.AIO_PROXY_HOME;
    process.env.AIO_PROXY_HOME = tmpAioHome;
    writeFileSync(
      join(tmpAioHome, 'codex_models_cache.json'),
      JSON.stringify({ models: [], fetched_at: new Date().toISOString() }),
      'utf8',
    );
  });

  afterEach(() => {
    if (originalAioHome === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = originalAioHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmpAioHome, { recursive: true, force: true });
  });

  test('client_version query returns codex catalog', async () => {
    const app = await createServer({ config });

    const response = await app.request('/v1/models?client_version=0.146.0', undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
    for (const model of body.models) {
      expect(typeof model.slug).toBe('string');
      expect(typeof model.base_instructions).toBe('string');
    }
    expect(body.object).toBeUndefined();
  });

  test('no client_version query returns openai list catalog', async () => {
    const app = await createServer({ config });

    const response = await app.request('/v1/models', undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.models).toBeUndefined();
  });
});
