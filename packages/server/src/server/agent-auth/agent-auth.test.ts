import { expect, test } from 'bun:test';

import type { AgentAccessAuthentication } from '@aio-proxy/core';
import { Hono } from 'hono';

import { requireModelAuthentication, type AgentEnv } from './agent-auth';

const VALID_GRANT = {
  tokenHash: 'hash',
  familyId: 'family',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  target: 'opencode',
  expiresAt: 901_000,
} as const;

function authenticatedApp(input: {
  readonly apiKeys: readonly { readonly key: string }[];
  readonly authenticateAgent: (token: string) => AgentAccessAuthentication;
}) {
  const app = new Hono<AgentEnv>();
  app.use(
    '*',
    requireModelAuthentication({
      apiKeys: () => input.apiKeys,
      authenticateAgent: input.authenticateAgent,
    }),
  );
  app.get('/probe', (context) =>
    context.json({
      authorization: context.req.header('authorization') ?? null,
      xApiKey: context.req.header('x-api-key') ?? null,
      xGoogApiKey: context.req.header('x-goog-api-key') ?? null,
      search: new URL(context.req.url).search,
      target: context.get('agentGrant')?.target ?? null,
    }),
  );
  return app;
}

const staticCases = [
  ['anonymous when unlocked', [], '/probe', {}, 200],
  ['valid bearer', [{ key: 'static' }], '/probe', { authorization: 'Bearer static' }, 200],
  ['valid x-api-key', [{ key: 'static' }], '/probe', { 'x-api-key': 'static' }, 200],
  ['valid Gemini header', [{ key: 'static' }], '/probe', { 'x-goog-api-key': 'static' }, 200],
  ['valid Gemini query', [{ key: 'static' }], '/probe?key=static', {}, 200],
  ['invalid static key', [{ key: 'static' }], '/probe', { authorization: 'Bearer wrong' }, 401],
] as const;

test.each(staticCases)('%s', async (_name, apiKeys, path, headers, status) => {
  const app = authenticatedApp({ apiKeys, authenticateAgent: () => ({ status: 'invalid' }) });
  expect((await app.request(path, { headers })).status).toBe(status);
});

test.each([[], [{ key: 'static' }]] as const)(
  'valid Agent access is accepted with static configuration %j',
  async (apiKeys) => {
    const app = authenticatedApp({ apiKeys, authenticateAgent: () => ({ status: 'valid', grant: VALID_GRANT }) });
    const response = await app.request('/probe', {
      headers: { authorization: 'Bearer aio_agent_at_v1_valid' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ target: 'opencode', authorization: null });
  },
);

test.each(['invalid', 'expired'] as const)(
  'recognizable %s Agent access never degrades to anonymous mode',
  async (status) => {
    const app = authenticatedApp({ apiKeys: [], authenticateAgent: () => ({ status }) });
    const response = await app.request('/probe', {
      headers: { authorization: 'Bearer aio_agent_at_v1_invalid' },
    });
    expect(response.status).toBe(401);
  },
);

test.each(['aio_agent_rt_v1_refresh', 'aio_agent_at_v1_revoked'])(
  'reserved bearer %s cannot enter static or anonymous auth',
  async (token) => {
    const app = authenticatedApp({ apiKeys: [], authenticateAgent: () => ({ status: 'invalid' }) });
    expect((await app.request('/probe', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  },
);

test('static credentials and credential query fields are stripped before dispatch', async () => {
  const app = authenticatedApp({ apiKeys: [{ key: 'static' }], authenticateAgent: () => ({ status: 'invalid' }) });
  const response = await app.request('/probe?key=static&keep=yes', {
    headers: { authorization: 'Bearer static', 'x-api-key': 'static', 'x-goog-api-key': 'static' },
  });
  expect(await response.json()).toMatchObject({
    authorization: null,
    xApiKey: null,
    xGoogApiKey: null,
    search: '?keep=yes',
    target: null,
  });
});
