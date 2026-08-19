import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createBaseServer } from '@aio-proxy/server';

import { loopbackServer } from '../dashboard-auth/test-support';

// A DNS-rebound page is indistinguishable from the real dashboard on every signal the server
// previously checked: it arrives over a loopback socket, so `requestIP` reports 127.0.0.1, and the
// browser treats it as same-origin, so `sec-fetch-site` says `same-origin` and no CORS header is
// needed for the script to read the body. The Origin/CSRF guard only ran on POST/PUT/PATCH/DELETE,
// which left every unauthenticated dashboard read — including the provider editor's real
// credentials — open to any page the user happened to visit.
describe('dashboard DNS-rebinding guard', () => {
  let dir: string;
  const sentinel = 'sk-sentinel-do-not-leak';
  const config = {
    server: { port: 9_317 },
    providers: {
      upstream: {
        kind: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example.com/v1',
        apiKey: sentinel,
        models: ['gpt-4o'],
      },
    },
  };
  const createServer = () => createBaseServer({ config, dbHome: dir, watchConfig: false });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aio-proxy-rebind-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('GET edit-view refuses a foreign Host and does not disclose the api key', async () => {
    const app = await createServer();
    const res = await app.request(
      '/dashboard/api/providers/upstream/edit-view',
      { headers: { host: 'evil.example:9317', 'sec-fetch-site': 'same-origin' } },
      loopbackServer,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(sentinel);
  });

  test('GET edit-view still serves the real api key to the loopback dashboard', async () => {
    const app = await createServer();
    const res = await app.request(
      '/dashboard/api/providers/upstream/edit-view',
      { headers: { host: '127.0.0.1:9317' } },
      loopbackServer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: { apiKey?: string } };
    expect(body.provider.apiKey).toBe(sentinel);
  });

  test('the provider list is not enumerable from a foreign Host', async () => {
    const app = await createServer();
    const res = await app.request(
      '/dashboard/api/providers',
      { headers: { host: 'evil.example:9317' } },
      loopbackServer,
    );
    expect(res.status).toBe(403);
  });

  test('GET /admin refuses a foreign Host', async () => {
    const app = await createServer();
    const res = await app.request(
      '/admin/reload',
      { method: 'POST', headers: { host: 'evil.example:9317' } },
      loopbackServer,
    );
    expect(res.status).toBe(403);
  });
});
