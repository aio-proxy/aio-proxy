import { expect, test } from 'bun:test';

import {
  AgentCatalogV1Schema,
  AgentManagedMarkerSchema,
  AgentManagedStateV1Schema,
  AgentTokenResponseSchema,
  AgentTargetSchema,
  hasReservedAgentTokenPrefix,
} from './agent-integration';

const catalogV1 = {
  schema_version: 1,
  agent: 'opencode',
  models: [
    {
      id: 'gpt-x',
      name: 'GPT X',
      reasoning: true,
      tool_call: true,
      temperature: false,
      attachment: true,
      input: ['text', 'image'],
      context_window: 128_000,
      max_output_tokens: null,
    },
  ],
} as const;

test('schema 1 preserves every capability required by bundled adapters', () => {
  expect(AgentCatalogV1Schema.parse(catalogV1).models[0]).toMatchObject({
    tool_call: true,
    temperature: false,
    attachment: true,
  });
});

const managedMarker = {
  format: 1,
  managedBy: 'aio-proxy',
  agent: 'pi',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3',
  endpoint: 'http://127.0.0.1:9317',
} as const;

test('marker accepts only canonical loopback installations', () => {
  expect(AgentManagedMarkerSchema.safeParse(managedMarker).success).toBe(true);
  expect(AgentManagedMarkerSchema.safeParse({ ...managedMarker, endpoint: 'https://proxy.example' }).success).toBe(
    false,
  );
  expect(AgentManagedMarkerSchema.safeParse({ ...managedMarker, adapterVersion: 'latest' }).success).toBe(false);
});

test.each(['http://localhost:9317', 'http://[::1]:9317', 'http://127.1.2.3:9317'] as const)(
  'marker accepts canonical loopback endpoint %s',
  (endpoint) => {
    expect(AgentManagedMarkerSchema.safeParse({ ...managedMarker, endpoint }).success).toBe(true);
  },
);

test.each([
  'http://8.8.8.8:9317',
  'https://127.0.0.1:9317',
  'http://user:pass@127.0.0.1:9317',
  'http://127.0.0.1:9317/v1',
  'http://127.0.0.1:9317/?q=1',
  'http://127.0.0.1:9317/#section',
] as const)('marker rejects non-canonical endpoint %s', (endpoint) => {
  expect(AgentManagedMarkerSchema.safeParse({ ...managedMarker, endpoint }).success).toBe(false);
});

const managedState = {
  format: 1,
  catalogSchema: 1,
  lastSuccessfulAt: '2026-08-18T00:00:00.000Z',
  lkg: catalogV1,
} as const;

test('managed state accepts only fixed error categories', () => {
  expect(
    AgentManagedStateV1Schema.safeParse({
      format: 1,
      catalogSchema: 1,
      status: 'missing',
      lastSuccessfulAt: null,
      lastError: 'network',
      lkg: null,
    }).success,
  ).toBe(true);
  expect(
    AgentManagedStateV1Schema.safeParse({
      format: 1,
      catalogSchema: 1,
      status: 'missing',
      lastSuccessfulAt: null,
      lastError: 'secret bearer value',
      lkg: null,
    }).success,
  ).toBe(false);
  expect(
    AgentManagedStateV1Schema.safeParse({
      format: 1,
      catalogSchema: 1,
      status: 'fresh',
      lastSuccessfulAt: null,
      lastError: null,
      lkg: null,
    }).success,
  ).toBe(false);
});

test('managed state accepts missing with a null lastError', () => {
  expect(
    AgentManagedStateV1Schema.safeParse({
      format: 1,
      catalogSchema: 1,
      status: 'missing',
      lastSuccessfulAt: null,
      lastError: null,
      lkg: null,
    }).success,
  ).toBe(true);
});

test('managed state rejects missing leftover last-known-good catalog', () => {
  expect(
    AgentManagedStateV1Schema.safeParse({
      format: 1,
      catalogSchema: 1,
      status: 'missing',
      lastSuccessfulAt: null,
      lastError: 'network',
      lkg: catalogV1,
    }).success,
  ).toBe(false);
});

test('managed state accepts consistent stale snapshots', () => {
  expect(
    AgentManagedStateV1Schema.safeParse({
      ...managedState,
      status: 'stale',
      lastError: 'network',
    }).success,
  ).toBe(true);
});

test('managed state rejects stale snapshots that omit lastError', () => {
  expect(
    AgentManagedStateV1Schema.safeParse({
      ...managedState,
      status: 'stale',
      lastError: null,
    }).success,
  ).toBe(false);
});

test('managed state accepts consistent fresh snapshots', () => {
  expect(
    AgentManagedStateV1Schema.safeParse({
      ...managedState,
      status: 'fresh',
      lastError: null,
    }).success,
  ).toBe(true);
});

test('managed state rejects fresh snapshots that retain lastError', () => {
  expect(
    AgentManagedStateV1Schema.safeParse({
      ...managedState,
      status: 'fresh',
      lastError: 'network',
    }).success,
  ).toBe(false);
});

test('recognizes both reserved Agent credential families', () => {
  expect(hasReservedAgentTokenPrefix('aio_agent_at_v1_x')).toBe(true);
  expect(hasReservedAgentTokenPrefix('aio_agent_rt_v1_x')).toBe(true);
  expect(hasReservedAgentTokenPrefix('ordinary-static-key')).toBe(false);
  expect(AgentTargetSchema.options).toEqual(['opencode', 'pi', 'omp']);
});

test('token responses require one exact 32-byte base64url payload', () => {
  const base = {
    token_type: 'Bearer',
    access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
    refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`,
    expires_in: 900,
  } as const;
  expect(AgentTokenResponseSchema.safeParse(base).success).toBe(true);
  expect(AgentTokenResponseSchema.safeParse({ ...base, access_token: 'aio_agent_at_v1_short' }).success).toBe(false);
});
