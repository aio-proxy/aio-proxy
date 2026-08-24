import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createDashboardProviderFixture } from './dashboard-providers-mutation.test-support';

let cleanup: () => void;
let onDisk: Awaited<ReturnType<typeof createDashboardProviderFixture>>['onDisk'];
let req: Awaited<ReturnType<typeof createDashboardProviderFixture>>['req'];
const postProvider = (body: unknown) => req('POST', '/providers', body);

beforeEach(async () => {
  const fixture = await createDashboardProviderFixture('aio-dashboard-provider-basic-');
  cleanup = fixture.cleanup;
  onDisk = fixture.onDisk;
  req = fixture.req;
});
afterEach(() => cleanup());

describe('dashboard provider CRUD', () => {
  test('1. GET /providers list carries clientModels and hasApiKey fields', async () => {
    const res = await req('GET', '/providers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers[0]).toHaveProperty('clientModels');
    const api = body.providers.find((provider: { id: string }) => provider.id === 'seed-api');
    expect(api).toHaveProperty('clientModels');
    expect(api.hasApiKey).toBe(true);
    expect(api.protocol).toBe('openai-response');
    const aiSdk = body.providers.find((provider: { id: string }) => provider.id === 'seed-ai');
    expect(aiSdk.packageName).toBe('@ai-sdk/openai-compatible');
    expect(aiSdk).not.toHaveProperty('protocol');
  });

  test('2. POST new api provider returns 201 and writes it to disk', async () => {
    const res = await req('POST', '/providers', {
      kind: 'api',
      id: 'newapi',
      protocol: 'openai-compatible',
      baseURL: 'https://newapi.example.com',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider.id).toBe('newapi');
    expect(body.provider.kind).toBe('api');
    expect(onDisk().providers.newapi).toBeDefined();
  });

  test('3. POST duplicate id returns 409', async () => {
    const res = await req('POST', '/providers', {
      kind: 'api',
      id: 'seed-api',
      protocol: 'openai-response',
      baseURL: 'https://dup.example.com',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('provider id already exists');
  });

  test('4. POST oauth kind returns 400 (mutation union omits oauth)', async () => {
    const res = await req('POST', '/providers', {
      kind: 'oauth',
      id: 'newoauth',
      vendor: 'legacy-provider',
    });
    expect(res.status).toBe(400);
  });

  test('POST malformed body missing baseURL returns 400 with zod details', async () => {
    const response = await postProvider({
      kind: 'api',
      id: 'missing-base-url',
      protocol: 'openai-compatible',
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(
      body.details.some((issue: { path: unknown[] }) => Array.isArray(issue.path) && issue.path.includes('baseURL')),
    ).toBe(true);
  });

  test('POST rejects removed baseUrl spelling', async () => {
    const response = await postProvider({
      kind: 'api',
      id: 'legacy-spelling',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com',
    });
    expect(response.status).toBe(400);
  });

  test('6. PUT rename attempt (body.id !== :id) returns 400', async () => {
    const res = await req('PUT', '/providers/seed-api', {
      kind: 'api',
      id: 'renamed',
      protocol: 'openai-response',
      baseURL: 'https://api.example.com',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('provider rename not supported');
  });

  test('7. PUT with apiKey omitted preserves the stored key', async () => {
    const res = await req('PUT', '/providers/seed-api', {
      kind: 'api',
      id: 'seed-api',
      protocol: 'openai-response',
      baseURL: 'https://api.example.com',
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers['seed-api'].apiKey).toBe('sk-preserved-value');
  });

  test('8. PUT with apiKey: "" preserves the stored key', async () => {
    const res = await req('PUT', '/providers/seed-api', {
      kind: 'api',
      id: 'seed-api',
      protocol: 'openai-response',
      baseURL: 'https://api.example.com',
      apiKey: '',
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers['seed-api'].apiKey).toBe('sk-preserved-value');
  });

  test('9. PUT with a new apiKey writes the new value', async () => {
    const res = await req('PUT', '/providers/seed-api', {
      kind: 'api',
      id: 'seed-api',
      protocol: 'openai-response',
      baseURL: 'https://api.example.com',
      apiKey: 'sk-new-value',
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers['seed-api'].apiKey).toBe('sk-new-value');
  });
});
