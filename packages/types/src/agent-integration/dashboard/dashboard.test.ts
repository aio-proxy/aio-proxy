import { expect, test } from 'bun:test';

import { AgentOperationRequestSchema, AgentOperationResultSchema } from './dashboard';

test('operation results refuse fields that could carry credentials', () => {
  const result = { target: 'opencode', status: 'installed' };
  expect(AgentOperationResultSchema.safeParse(result).success).toBe(true);
  expect(AgentOperationResultSchema.safeParse({ ...result, accessToken: 'aio_agent_at_v1_x' }).success).toBe(false);
  expect(AgentOperationResultSchema.safeParse({ ...result, bearerToken: 'sk-x' }).success).toBe(false);
});

test('codex setup input is required exactly for codex configure', () => {
  const codex = { providerId: 'aio-proxy', auth: { mode: 'command' }, migrateFrom: [], planToken: 't' };
  expect(AgentOperationRequestSchema.safeParse({ kind: 'configure', target: 'codex', codex }).success).toBe(true);
  expect(AgentOperationRequestSchema.safeParse({ kind: 'configure', target: 'codex' }).success).toBe(false);
  expect(AgentOperationRequestSchema.safeParse({ kind: 'configure', target: 'grok', codex }).success).toBe(false);
  expect(AgentOperationRequestSchema.safeParse({ kind: 'configure', target: 'grok' }).success).toBe(true);
});
