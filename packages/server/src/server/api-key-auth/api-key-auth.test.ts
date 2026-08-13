import { expect, test } from 'bun:test';

import { Hono } from 'hono';

import { requireApiKey } from './api-key-auth';

const appWithKeys = () => {
  const app = new Hono();
  app.use(
    '/*',
    requireApiKey(() => [{ key: 'caller-secret', label: 'CI' }]),
  );
  app.get('/v1/models', (context) =>
    context.json({
      authorization: context.req.header('authorization'),
      apiKey: context.req.header('x-api-key'),
      search: new URL(context.req.raw.url).search,
    }),
  );
  app.get('/v1beta/models', (context) =>
    context.json({
      googleApiKey: context.req.header('x-goog-api-key'),
      search: new URL(context.req.raw.url).search,
    }),
  );
  app.all('/*', (context) => context.text('ok'));
  return app;
};

test('rejects a request without a caller API key', async () => {
  expect((await appWithKeys().request('/v1/models')).status).toBe(401);
});

test('returns an Anthropic authentication error for invalid credentials', async () => {
  const response = await appWithKeys().request('/v1/messages', { method: 'POST' });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    type: 'error',
    error: { type: 'authentication_error', message: 'Invalid API key' },
  });
});

test('returns a Gemini authentication error for invalid credentials', async () => {
  const response = await appWithKeys().request('/v1beta/models/gemini-2.5-flash:generateContent', { method: 'POST' });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: { code: 401, message: 'Invalid API key', status: 'UNAUTHENTICATED' },
  });
});

test('accepts bearer authentication and removes caller credentials before dispatch', async () => {
  const response = await appWithKeys().request('/v1/models', {
    headers: { authorization: 'Bearer caller-secret', 'x-api-key': 'other-value' },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authorization: undefined, apiKey: undefined, search: '' });
});

test('accepts X-API-Key authentication', async () => {
  expect((await appWithKeys().request('/v1/models', { headers: { 'x-api-key': 'caller-secret' } })).status).toBe(200);
});

test('accepts and removes Gemini X-Goog-Api-Key authentication', async () => {
  const response = await appWithKeys().request('/v1beta/models', { headers: { 'x-goog-api-key': 'caller-secret' } });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ googleApiKey: undefined, search: '' });
});

test('accepts a Gemini query key and removes it before dispatch', async () => {
  const response = await appWithKeys().request('/v1beta/models?key=caller-secret&alt=sse');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ googleApiKey: undefined, search: '?alt=sse' });
});

test('accepts an auth_token query parameter and removes it before dispatch', async () => {
  const response = await appWithKeys().request('/v1/models?auth_token=caller-secret&foo=bar');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authorization: undefined, apiKey: undefined, search: '?foo=bar' });
});

test('strips caller query credentials from a POST body request before dispatch', async () => {
  const app = new Hono();
  app.use(
    '/*',
    requireApiKey(() => [{ key: 'caller-secret', label: 'CI' }]),
  );
  app.post('/v1beta/models/x:generateContent', async (context) =>
    context.json({ search: new URL(context.req.raw.url).search, body: await context.req.text() }),
  );

  const response = await app.request('/v1beta/models/x:generateContent?key=caller-secret&alt=sse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"contents":[]}',
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ search: '?alt=sse', body: '{"contents":[]}' });
});

test('leaves model routes open when no caller API keys are configured', async () => {
  const app = new Hono();
  app.use(
    '/v1/*',
    requireApiKey(() => []),
  );
  app.get('/v1/models', (context) => context.text('ok'));

  expect((await app.request('/v1/models')).status).toBe(200);
});
