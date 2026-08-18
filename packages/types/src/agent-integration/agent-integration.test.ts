import { expect, test } from 'bun:test';

import {
  AgentCatalogV1Schema,
  AgentManagedMarkerSchema,
  AgentManagedStateV1Schema,
  AgentTokenResponseSchema,
  AgentTargetSchema,
  hasReservedAgentTokenPrefix,
} from './agent-integration';

test('schema 1 preserves every capability required by bundled adapters', () => {
  expect(
    AgentCatalogV1Schema.parse({
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
    }).models[0],
  ).toMatchObject({ tool_call: true, temperature: false, attachment: true });
});

test('marker accepts only canonical loopback installations', () => {
  const base = {
    format: 1,
    managedBy: 'aio-proxy',
    agent: 'pi',
    installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
    adapterVersion: '1.2.3',
    endpoint: 'http://127.0.0.1:9317',
  } as const;
  expect(AgentManagedMarkerSchema.safeParse(base).success).toBe(true);
  expect(AgentManagedMarkerSchema.safeParse({ ...base, endpoint: 'https://proxy.example' }).success).toBe(false);
  expect(AgentManagedMarkerSchema.safeParse({ ...base, adapterVersion: 'latest' }).success).toBe(false);
});

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
