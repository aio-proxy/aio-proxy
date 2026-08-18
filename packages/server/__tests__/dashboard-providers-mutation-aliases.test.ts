import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createDashboardProviderFixture } from './dashboard-providers-mutation.test-support';

let cleanup: () => void;
let onDisk: Awaited<ReturnType<typeof createDashboardProviderFixture>>['onDisk'];
let req: Awaited<ReturnType<typeof createDashboardProviderFixture>>['req'];

beforeEach(async () => {
  const fixture = await createDashboardProviderFixture('aio-dashboard-provider-aliases-');
  cleanup = fixture.cleanup;
  onDisk = fixture.onDisk;
  req = fixture.req;
});
afterEach(() => cleanup());

describe('dashboard provider CRUD', () => {
  test('16. PUT preserves stored alias when the mutation body omits it', async () => {
    const res = await req('PUT', '/providers/seed-api', {
      kind: 'api',
      id: 'seed-api',
      protocol: 'openai-response',
      baseURL: 'https://changed.example.com',
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers['seed-api'].baseURL).toBe('https://changed.example.com');
    expect(onDisk().providers['seed-api']).not.toHaveProperty('baseUrl');
    expect(onDisk().providers['seed-api'].alias).toEqual({ 'gpt-4o': 'gpt-4o-upstream' });
  });

  test('17. GET edit-view includes the alias field for the read-only viewer', async () => {
    const res = await req('GET', '/providers/seed-api/edit-view');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider.alias).toBeDefined();
    expect(body.provider.alias['gpt-4o'].model).toBe('gpt-4o-upstream');
  });

  test('18. PUT that yields an invalid provider degrades that row without rejecting the config', async () => {
    const res = await req('PUT', '/providers/seed-api', {
      kind: 'api',
      id: 'seed-api',
      protocol: 'openai-response',
      baseURL: 'https://api.example.com',
      models: ['unrelated-model'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider: { id: 'seed-api', enabled: false, clientModels: [] },
    });
    expect(onDisk().providers['seed-api']).toMatchObject({
      models: ['unrelated-model'],
      alias: { 'gpt-4o': 'gpt-4o-upstream' },
    });
  });

  test('19. GET /providers surfaces the saved display name for an enabled provider', async () => {
    const put = await req('PUT', '/providers/seed-ai', {
      kind: 'ai-sdk',
      id: 'seed-ai',
      packageName: '@ai-sdk/openai-compatible',
      name: 'My Display Name',
    });
    expect(put.status).toBe(200);
    const res = await req('GET', '/providers');
    const body = await res.json();
    const ai = body.providers.find((provider: { id: string }) => provider.id === 'seed-ai');
    expect(ai.name).toBe('My Display Name');
  });

  test('20. GET edit-view redacts nested ai-sdk options secrets', async () => {
    const put = await req('PUT', '/providers/seed-ai', {
      kind: 'ai-sdk',
      id: 'seed-ai',
      packageName: '@ai-sdk/openai-compatible',
      options: { headers: { Authorization: 'Bearer nested-secret' } },
    });
    expect(put.status).toBe(200);
    const res = await req('GET', '/providers/seed-ai/edit-view');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider.options.headers.Authorization).toBe('****');
  });
});
