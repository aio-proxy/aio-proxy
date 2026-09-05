import { expect, test } from 'bun:test';

import type { AgentAccessAuthentication } from '@aio-proxy/core';
import { Hono } from 'hono';

import {
  agentCallerPrincipal,
  type CallerPrincipal,
  callerPrincipal,
  staticKeyCallerPrincipal,
} from '../../caller-principal';
import { sameCallerPrincipal } from '../../routes/realtime';
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
  // Registered ahead of the middleware on purpose: Hono only applies `app.use` to routes
  // registered after it, so this route mirrors `server.ts`'s `/v1/models` and lets a test
  // distinguish "no middleware ran" from a middleware-stamped anonymous caller.
  app.get('/unguarded', (context) => context.json({ stamped: context.get('callerPrincipal') ?? null }));
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
      principal: callerPrincipal(context),
      stamped: context.get('callerPrincipal') ?? null,
    }),
  );
  return app;
}

async function principalOf(app: Hono<AgentEnv>, path: string, headers: Record<string, string> = {}) {
  const response = await app.request(path, { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as { readonly principal: unknown; readonly stamped: unknown };
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

test('an authenticated Agent caller is identified by its installation', async () => {
  const app = authenticatedApp({ apiKeys: [], authenticateAgent: () => ({ status: 'valid', grant: VALID_GRANT }) });
  const body = await principalOf(app, '/probe', { authorization: 'Bearer aio_agent_at_v1_valid' });

  // Asserted exactly, not as a `toMatchObject` subset: an extra request-scoped field such as
  // a client address would make every request its own principal and 403 its own attach.
  expect(body.principal).toEqual(agentCallerPrincipal(VALID_GRANT.installationId));
});

test('a matched static key caller is identified by that key, not by another configured key', async () => {
  const app = authenticatedApp({
    apiKeys: [{ key: 'first' }, { key: 'second' }],
    authenticateAgent: () => ({ status: 'invalid' }),
  });
  const body = await principalOf(app, '/probe', { 'x-api-key': 'second' });

  expect(body.principal).toEqual(staticKeyCallerPrincipal('second'));
  expect(body.principal).not.toEqual(staticKeyCallerPrincipal('first'));
});

// A non-matching later credential source must not undo an earlier match: admitting the
// request while attributing it to no key, or to a key that never matched, would hand the
// caller a principal it cannot reproduce on its attach request.
test('a matching credential source is not undone by a later non-matching one', async () => {
  const app = authenticatedApp({ apiKeys: [{ key: 'first' }], authenticateAgent: () => ({ status: 'invalid' }) });
  const body = await principalOf(app, '/probe', { authorization: 'Bearer first', 'x-api-key': 'bogus' });

  expect(body.principal).toEqual(staticKeyCallerPrincipal('first'));
});

test('two distinguishable callers of an unlocked proxy converge on one anonymous principal', async () => {
  const app = authenticatedApp({ apiKeys: [], authenticateAgent: () => ({ status: 'invalid' }) });
  const first = await principalOf(app, '/probe?caller=one', { 'x-api-key': 'whatever' });
  const second = await principalOf(app, '/probe?caller=two');

  // Asserted against a literal, exactly: any request-scoped `id` (a client address is the
  // obvious temptation) would make each caller its own principal and 403 every attach.
  expect(first.principal).toEqual({ kind: 'anonymous' });
  expect(second.principal).toEqual({ kind: 'anonymous' });
  expect(sameCallerPrincipal(first.principal as CallerPrincipal, second.principal as CallerPrincipal)).toBe(true);
});

// Distinguishes "the middleware ran and found no configured keys" from "no middleware ran":
// only the former stamps, so an absent variable can never be mistaken for an open proxy.
test('an unlocked proxy stamps the anonymous principal instead of relying on the fallback', async () => {
  const app = authenticatedApp({ apiKeys: [], authenticateAgent: () => ({ status: 'invalid' }) });

  expect((await principalOf(app, '/probe')).stamped).toEqual({ kind: 'anonymous' });
  expect((await principalOf(app, '/unguarded')).stamped).toBeNull();
});
