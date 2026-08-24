import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createDashboardProviderFixture } from './dashboard-providers-mutation.test-support';

let cleanup: () => void;
let onDisk: Awaited<ReturnType<typeof createDashboardProviderFixture>>['onDisk'];
let req: Awaited<ReturnType<typeof createDashboardProviderFixture>>['req'];

beforeEach(async () => {
  const fixture = await createDashboardProviderFixture('aio-dashboard-provider-aliases-validation-');
  cleanup = fixture.cleanup;
  onDisk = fixture.onDisk;
  req = fixture.req;
});
afterEach(() => cleanup());

describe('dashboard provider CRUD', () => {
  test('21. POST api provider with models and alias including variants persists alias to disk', async () => {
    const res = await req('POST', '/providers', {
      kind: 'api',
      id: 'alias-test',
      protocol: 'openai-compatible',
      baseURL: 'https://alias-test.example.com',
      models: ['gpt-4o-upstream', 'o3-upstream'],
      alias: {
        'gpt-4o': {
          model: 'gpt-4o-upstream',
          variants: { thinking: { model: 'o3-upstream' } },
        },
      },
    });
    expect(res.status).toBe(201);
    const disk = onDisk().providers['alias-test'];
    expect(disk).toBeDefined();
    expect(disk.alias).toBeDefined();
    expect(disk.alias).toMatchObject({
      'gpt-4o': {
        model: 'gpt-4o-upstream',
        variants: [{ when: { effort: 'thinking' }, model: 'o3-upstream', preserve: false }],
      },
    });
  });

  test('22. PUT with a new alias replaces the stored alias', async () => {
    expect(
      (
        await req('POST', '/providers', {
          kind: 'api',
          id: 'alias-test',
          protocol: 'openai-compatible',
          baseURL: 'https://alias-test.example.com',
          models: ['gpt-4o-upstream', 'o3-upstream'],
          alias: {
            'gpt-4o': {
              model: 'gpt-4o-upstream',
              variants: { thinking: { model: 'o3-upstream' } },
            },
          },
        })
      ).status,
    ).toBe(201);
    const res = await req('PUT', '/providers/alias-test', {
      kind: 'api',
      id: 'alias-test',
      protocol: 'openai-compatible',
      baseURL: 'https://alias-test.example.com',
      models: ['gpt-4o-upstream', 'o3-upstream'],
      alias: { 'new-alias': { model: 'o3-upstream' } },
    });
    expect(res.status).toBe(200);
    const disk = onDisk().providers['alias-test'];
    const alias = disk.alias as Record<string, unknown>;
    expect(alias['new-alias']).toBeDefined();
    expect(alias['gpt-4o']).toBeUndefined();
  });

  test('23. PUT with an empty alias clears the stored alias', async () => {
    expect(
      (
        await req('POST', '/providers', {
          kind: 'api',
          id: 'alias-test',
          protocol: 'openai-compatible',
          baseURL: 'https://alias-test.example.com',
          models: ['gpt-4o-upstream', 'o3-upstream'],
          alias: {
            'gpt-4o': {
              model: 'gpt-4o-upstream',
              variants: { thinking: { model: 'o3-upstream' } },
            },
          },
        })
      ).status,
    ).toBe(201);
    const res = await req('PUT', '/providers/alias-test', {
      kind: 'api',
      id: 'alias-test',
      protocol: 'openai-compatible',
      baseURL: 'https://alias-test.example.com',
      models: ['gpt-4o-upstream', 'o3-upstream'],
      alias: {},
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers['alias-test'].alias).toEqual({});
  });

  test('24. POST with alias target not listed in models returns 400 validation failed', async () => {
    const res = await req('POST', '/providers', {
      kind: 'api',
      id: 'bad-alias-target',
      protocol: 'openai-compatible',
      baseURL: 'https://bad-alias.example.com',
      models: ['real-model'],
      alias: { 'my-alias': { model: 'nonexistent-model' } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation failed');
  });

  test('25. POST with alias variant target not listed in models returns 400 validation failed', async () => {
    const res = await req('POST', '/providers', {
      kind: 'api',
      id: 'bad-variant-target',
      protocol: 'openai-compatible',
      baseURL: 'https://bad-variant.example.com',
      models: ['real-model'],
      alias: {
        'my-alias': {
          model: 'real-model',
          variants: { thinking: { model: 'missing-model' } },
        },
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation failed');
  });

  test('26. PUT with redacted nested options retains the stored secret', async () => {
    const seed = await req('PUT', '/providers/seed-ai', {
      kind: 'ai-sdk',
      id: 'seed-ai',
      packageName: '@ai-sdk/openai-compatible',
      options: { headers: { Authorization: 'Bearer retained-secret' } },
    });
    expect(seed.status).toBe(200);
    const editView = await req('GET', '/providers/seed-ai/edit-view');
    const { provider } = await editView.json();

    const save = await req('PUT', '/providers/seed-ai', { ...provider, name: 'Renamed without secret loss' });

    expect(save.status).toBe(200);
    expect(onDisk().providers['seed-ai'].options).toEqual({
      headers: { Authorization: 'Bearer retained-secret' },
    });
  });
});
