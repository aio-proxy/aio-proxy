import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentIdentityService, type IssuedAgentCredential } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';

import { createServer as createBaseServer } from '#server-test-lifecycle';

import { config } from '../../__tests__/server.test-support';
import { loopbackServer } from '../dashboard-auth/test-support';

describe('GET /v1/models client_version routing', () => {
  let dir: string;
  let tmpAioHome: string;
  let originalAioHome: string | undefined;
  let lockedHome: string;
  let app: Awaited<ReturnType<typeof createBaseServer>>;
  let lockedApp: Awaited<ReturnType<typeof createBaseServer>>;
  let opencode: IssuedAgentCredential;
  let pi: IssuedAgentCredential;
  let omp: IssuedAgentCredential;
  let closeIdentity: () => void = () => {};

  beforeEach(async () => {
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
    const identityHome = mkdtempSync(join(tmpdir(), 'aio-proxy-model-auth-'));
    const identityDb = openDb({ home: identityHome });
    closeIdentity = () => {
      identityDb.close();
      rmSync(identityHome, { recursive: true, force: true });
    };
    const identity = createAgentIdentityService(identityDb.sqlite, { randomUUID });
    opencode = identity.issueCredential({
      installationId: randomUUID(),
      target: 'opencode',
      adapterVersion: '1.2.3',
    });
    pi = identity.issueCredential({
      installationId: randomUUID(),
      target: 'pi',
      adapterVersion: '1.2.3',
    });
    omp = identity.issueCredential({
      installationId: randomUUID(),
      target: 'omp',
      adapterVersion: '1.2.3',
    });
    app = await createBaseServer({ config, dbHome: dir, __test: { agentIdentity: identity } });
    lockedHome = mkdtempSync(join(tmpdir(), 'aio-proxy-locked-models-'));
    lockedApp = await createBaseServer({
      config: { ...config, server: { ...config.server, apiKeys: [{ key: 'static-key' }] } },
      dbHome: lockedHome,
      __test: { agentIdentity: identity },
    });
  });

  afterEach(() => {
    app?.close();
    lockedApp?.close();
    closeIdentity();
    closeIdentity = () => {};
    if (originalAioHome === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = originalAioHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(lockedHome, { recursive: true, force: true });
    rmSync(tmpAioHome, { recursive: true, force: true });
  });

  const cases = [
    ['opencode', 'opencode', 'opencode', 200],
    ['pi', 'pi', 'pi', 200],
    ['omp', 'omp', 'omp', 200],
    ['anonymous', null, 'opencode', 401],
    ['target mismatch', 'opencode', 'pi', 403],
  ] as const;

  test.each(cases)('%s Agent catalog dispatch', async (_name, credentialTarget, agent, status) => {
    const credential =
      credentialTarget === null
        ? undefined
        : credentialTarget === 'opencode'
          ? opencode
          : credentialTarget === 'pi'
            ? pi
            : omp;
    const headers = credential === undefined ? {} : { authorization: `Bearer ${credential.accessToken}` };
    const response = await app.request(
      `/v1/models?agent=${agent}&adapter_version=1.2.3&schema_version=1`,
      { headers },
      loopbackServer,
    );
    expect(response.status).toBe(status);
    if (status === 200) expect(await response.json()).toMatchObject({ schema_version: 1, agent });
  });

  test.each([
    ['/v1/models?agent=opencode&schema_version=1', 400],
    ['/v1/models?agent=opencode&adapter_version=latest&schema_version=1', 400],
    ['/v1/models?agent=opencode&adapter_version=1.2.3&schema_version=2', 400],
    ['/v1/models', 400],
  ] as const)('rejects malformed or missing Agent negotiation: %s', async (path, status) => {
    const response = await app.request(
      path,
      { headers: { authorization: `Bearer ${opencode.accessToken}` } },
      loopbackServer,
    );
    expect(response.status).toBe(status);
    if (path.endsWith('schema_version=2')) {
      expect(await response.json()).toEqual({
        error: { code: 'unsupported_schema', message: 'Agent catalog schema 2 is not supported.' },
        supported_schema_versions: [1],
      });
    }
  });

  test.each([
    '/v1/models?agent=opencode&schema_version=1',
    '/v1/models?agent=opencode&adapter_version=latest&schema_version=1',
    '/v1/models?agent=opencode&adapter_version=1.2.3&schema_version=2',
  ] as const)('malformed Agent negotiation wins over the global API-key gate: %s', async (path) => {
    const response = await lockedApp.request(path, {}, loopbackServer);
    expect(response.status).toBe(400);
  });

  test('Agent negotiation wins over client_version and static keys cannot read it', async () => {
    const agentResponse = await app.request(
      '/v1/models?agent=opencode&adapter_version=1.2.3&schema_version=1&client_version=0.146.0',
      { headers: { authorization: `Bearer ${opencode.accessToken}` } },
      loopbackServer,
    );
    expect(await agentResponse.json()).toMatchObject({ schema_version: 1, agent: 'opencode' });
    expect(
      (
        await lockedApp.request(
          '/v1/models?agent=opencode&adapter_version=1.2.3&schema_version=1',
          { headers: { authorization: 'Bearer static-key' } },
          loopbackServer,
        )
      ).status,
    ).toBe(401);
  });

  test('client_version query returns codex catalog', async () => {
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
    const response = await app.request('/v1/models', undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.models).toBeUndefined();
  });
});
