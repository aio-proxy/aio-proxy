import { expect, test } from 'bun:test';

import type { ZodType } from 'zod';

import * as dashboard from './dashboard-oauth';
import { DashboardOAuthSessionSchema } from './dashboard-oauth';

test('dashboard OAuth capability schema accepts safe form metadata and rejects secret values', () => {
  expect(dashboard).toHaveProperty('DashboardOAuthCapabilitySchema');
  const schema = Reflect.get(dashboard, 'DashboardOAuthCapabilitySchema') as ZodType;
  const capability = {
    plugin: '@example/oauth',
    capability: 'default',
    displayName: { default: 'Example OAuth', 'zh-Hans': '示例 OAuth' },
    description: 'Example account',
    defaults: { deploymentType: 'github.com' },
    form: [
      {
        type: 'select',
        key: 'deploymentType',
        label: 'Deployment',
        options: [{ value: 'github.com', label: 'GitHub.com' }],
      },
      { type: 'secret', key: 'token', label: 'Token', configured: false },
    ],
  };

  expect(schema.parse(capability)).toEqual(capability);
  expect(schema.safeParse({ ...capability, label: 'Example OAuth' }).success).toBe(false);
  expect(schema.safeParse({ ...capability, icon: 'openai' }).success).toBe(false);
  expect(() =>
    schema.parse({
      ...capability,
      form: [{ type: 'secret', key: 'token', label: 'Token', configured: false, value: 'secret' }],
    }),
  ).toThrow();
});

test('dashboard OAuth session schema exposes only safe authorization state', () => {
  expect(dashboard).toHaveProperty('DashboardOAuthSessionSchema');
  const schema = Reflect.get(dashboard, 'DashboardOAuthSessionSchema') as ZodType;
  const session = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    status: 'device_code',
    url: 'https://example.com/device',
    userCode: 'ABCD-EFGH',
    instructions: 'Enter the code',
  };

  expect(schema.parse(session)).toEqual(session);
  expect(schema.parse({ id: session.id, status: 'discovering' })).toEqual({
    id: session.id,
    status: 'discovering',
  });
  expect(() => schema.parse({ ...session, credential: 'secret' })).toThrow();
});

test('dashboard OAuth session start accepts a complete routing patch without identity fields', () => {
  expect(dashboard).toHaveProperty('DashboardOAuthSessionStartSchema');
  const schema = Reflect.get(dashboard, 'DashboardOAuthSessionStartSchema') as ZodType;
  const request = {
    targetProviderId: 'person',
    publicValues: { tenant: 'enterprise' },
    secrets: {},
    clearSecrets: [],
    providerPatch: {
      name: 'Work',
      enabled: false,
      priority: 3,
      weight: 7,
      alias: { chat: { model: 'model-1' } },
      proxy: null,
    },
  };

  expect(schema.parse(request)).toMatchObject(request);
  expect(() =>
    schema.parse({ ...request, providerPatch: { ...request.providerPatch, plugin: '@example/other' } }),
  ).toThrow();
  expect(() => schema.parse({ ...request, providerPatch: { ...request.providerPatch, proxy: '****' } })).toThrow();
  expect(() =>
    schema.parse({ ...request, providerPatch: { ...request.providerPatch, proxy: 'socks5://localhost:1080' } }),
  ).toThrow();
});

test('dashboard OAuth provider patch canonicalizes weight and keeps omitted weight optional', () => {
  const schema = dashboard.DashboardOAuthProviderPatchSchema;
  expect(schema.parse({ enabled: true, weight: 1.6, proxy: false }).weight).toBe(2);
  expect(schema.parse({ enabled: true, weight: -3, proxy: false }).weight).toBe(0);
  expect(schema.parse({ enabled: true, weight: 10_001, proxy: false }).weight).toBe(10_000);
  expect(schema.parse({ enabled: true, proxy: false }).weight).toBeUndefined();
});

test('accepts an authorize_url session without a user code', () => {
  const parsed = DashboardOAuthSessionSchema.parse({
    id: '00000000-0000-4000-8000-000000000000',
    status: 'authorize_url',
    url: 'https://cursor.com/loginDeepControl?challenge=c&uuid=u&mode=login&redirectTarget=cli',
  });
  expect(parsed.status).toBe('authorize_url');
});

test('rejects an authorize_url session with a non-URL', () => {
  expect(() =>
    DashboardOAuthSessionSchema.parse({
      id: '00000000-0000-4000-8000-000000000000',
      status: 'authorize_url',
      url: 'not-a-url',
    }),
  ).toThrow();
});

// The edit view carries the plugin's default aliases so the editor can offer them, but a plugin that
// has none must keep the field absent rather than send an empty object — and the shape is the same
// `AliasConfig` the provider stores, so `preserve` defaults here exactly as it does on save.
test('provider edit view carries optional plugin default aliases as alias configs', () => {
  expect(dashboard).toHaveProperty('DashboardOAuthProviderEditSchema');
  const schema = Reflect.get(dashboard, 'DashboardOAuthProviderEditSchema') as ZodType;
  const view = { accountLabel: 'Work', publicValues: {}, form: [], models: ['model-1'] };

  expect(schema.parse(view)).toEqual(view);
  expect(schema.parse({ ...view, pluginAliases: { chat: { model: 'model-1' } } })).toEqual({
    ...view,
    pluginAliases: { chat: { model: 'model-1', preserve: false } },
  });
  expect(schema.safeParse({ ...view, pluginAliases: { chat: { model: 42 } } }).success).toBe(false);
  expect(schema.safeParse({ ...view, pluginAlias: {} }).success).toBe(false);
});

test('dashboard OAuth session start accepts a loopback dashboard origin', () => {
  const schema = dashboard.DashboardOAuthSessionStartSchema;
  const request = {
    capability: { plugin: '@example/oauth', capability: 'default' },
    publicValues: {},
    secrets: {},
    clearSecrets: [],
    completeUrl: 'http://localhost:3000/dashboard/oauth/complete',
  };
  expect(schema.parse(request).completeUrl).toBe(request.completeUrl);
  expect(() => schema.parse({ ...request, completeUrl: 'javascript:alert(1)' })).toThrow();
  expect(() => schema.parse({ ...request, completeUrl: 'https://evil.example/dashboard/oauth/complete' })).toThrow();
});

test('dashboardOAuthCompleteUrl keeps loopback origins and omits remote ones', () => {
  expect(dashboard.dashboardOAuthCompleteUrl('http://localhost:3000')).toBe(
    'http://localhost:3000/dashboard/oauth/complete',
  );
  expect(dashboard.dashboardOAuthCompleteUrl('https://proxy.example')).toBeUndefined();
});
