import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createBaseServer } from '#server-test-lifecycle';

import { config } from '../../__tests__/server.test-support';
import { loopbackServer } from '../dashboard-auth/test-support';

describe('GET /v1/models client_version routing', () => {
  let dir: string;
  let tmpAioHome: string;
  let originalAioHome: string | undefined;

  const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
    createBaseServer({ ...options, dbHome: dir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aio-proxy-server-'));
    tmpAioHome = mkdtempSync(join(tmpdir(), 'aio-proxy-home-'));
    originalAioHome = process.env.AIO_PROXY_HOME;
    process.env.AIO_PROXY_HOME = tmpAioHome;
    // Seed the fileCacheStorage entry the endpoint actually reads
    // (AIO_PROXY_HOME/tmp/cache-storage/<key>.json) so the request never touches
    // the network. The config's aliases route to non-Codex modelIds, so every
    // entry is synthesized (Case B); the fresh, empty cache just suppresses the
    // upstream fetch.
    const cacheDir = join(tmpAioHome, 'tmp', 'cache-storage');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'codex-models.json'),
      JSON.stringify({ value: JSON.stringify({ models: [] }), updatedAt: new Date().toISOString() }),
      'utf8',
    );
    // The models.dev catalog now resolves through the same fileCacheStorage
    // home. Seed an empty provider map so slug metadata lookups resolve to
    // nothing without hitting the network.
    writeFileSync(
      join(cacheDir, 'models-dev-providers.json'),
      JSON.stringify({ value: { openrouter: { models: {} } }, updatedAt: new Date().toISOString() }),
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
