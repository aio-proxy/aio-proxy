import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createDashboardProviderFixture } from './dashboard-providers-mutation.test-support';

const decoder = new TextDecoder();
let fixture: Awaited<ReturnType<typeof createDashboardProviderFixture>>;
let cleanup: () => void;
let onDisk: Awaited<ReturnType<typeof createDashboardProviderFixture>>['onDisk'];
let req: Awaited<ReturnType<typeof createDashboardProviderFixture>>['req'];
let requestPathless: Awaited<ReturnType<typeof createDashboardProviderFixture>>['requestPathless'];
let requestPathlessProviders: Awaited<ReturnType<typeof createDashboardProviderFixture>>['requestPathlessProviders'];

async function readNextEventText(stream: Response, timeoutMs = 2_000): Promise<string> {
  const reader = stream.body?.getReader();
  if (reader === undefined) {
    throw new Error('dashboard event stream body is missing');
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('timed out waiting for dashboard event')), timeoutMs);
  });
  try {
    const chunk = await Promise.race([reader.read(), deadline]);
    return chunk.done ? '' : decoder.decode(chunk.value);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await reader.cancel();
  }
}

beforeEach(async () => {
  fixture = await createDashboardProviderFixture('aio-dashboard-provider-basic-lifecycle-');
  cleanup = fixture.cleanup;
  onDisk = fixture.onDisk;
  req = fixture.req;
  requestPathless = fixture.requestPathless;
  requestPathlessProviders = fixture.requestPathlessProviders;
});
afterEach(() => cleanup());

describe('dashboard provider CRUD', () => {
  test('10. PUT nonexistent provider returns 404', async () => {
    const res = await req('PUT', '/providers/ghost', {
      kind: 'api',
      id: 'ghost',
      protocol: 'openai-response',
      baseURL: 'https://ghost.example.com',
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('provider not found');
  });

  test('11. DELETE seed-oauth removes it from disk', async () => {
    const res = await req('DELETE', '/providers/seed-oauth');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, id: 'seed-oauth' });
    expect(onDisk().providers['seed-oauth']).toBeUndefined();
  });

  test('12. DELETE nonexistent provider returns 404', async () => {
    const res = await req('DELETE', '/providers/ghost');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('provider not found');
  });

  test('13. GET edit-view returns the real apiKey', async () => {
    const res = await req('GET', '/providers/seed-api/edit-view');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider.apiKey).toBe('sk-preserved-value');
    expect(body.provider).not.toHaveProperty('hasApiKey');
  });

  test('14. SSE config.changed fires after POST', async () => {
    const stream = await req('GET', '/events');
    expect(stream.status).toBe(200);
    const post = await req('POST', '/providers', {
      kind: 'api',
      id: 'sseapi',
      protocol: 'openai-compatible',
      baseURL: 'https://sse.example.com',
    });
    expect(post.status).toBe(201);
    const text = await readNextEventText(stream);
    expect(text).toContain('event: config.changed');
  });

  test('15. POST without a configured config path returns 409', async () => {
    const res = await requestPathless({
      kind: 'api',
      id: 'nopath',
      protocol: 'openai-response',
      baseURL: 'https://nopath.example.com',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('config file path is not configured');
  });

  test('pathless server setup does not inherit prior fixture mutations', async () => {
    const priorMutationProbe = await requestPathless({
      kind: 'api',
      id: 'newapi',
      protocol: 'openai-compatible',
      baseURL: 'https://newapi.example.com',
    });
    expect(priorMutationProbe.status).toBe(409);
    expect((await priorMutationProbe.json()).error).toBe('config file path is not configured');

    Object.assign(fixture.config.providers, {
      'leak-probe': {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://leak.example.com',
      },
    });
    const pathlessProviders = await requestPathlessProviders();
    const pathlessBody = await pathlessProviders.json();
    expect(pathlessBody.providers.some((provider: { id: string }) => provider.id === 'leak-probe')).toBe(false);
  });
});
