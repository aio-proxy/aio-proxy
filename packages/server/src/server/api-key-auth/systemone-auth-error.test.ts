import { expect, test } from 'bun:test';

import { Hono } from 'hono';

import { requireApiKey } from './api-key-auth';

const appWithKeys = () => {
  const app = new Hono();
  app.use(
    '/*',
    requireApiKey(() => [{ key: 'caller-secret' }]),
  );
  app.all('/*', (context) => context.text('ok'));
  return app;
};

/** System One clients read a flat `{ message, error_type }`. The OpenAI default this
 *  would otherwise fall through to nests everything under `error`, which their parser
 *  reads as a body carrying neither a message nor a type. */
test('returns a System One authentication error for invalid credentials', async () => {
  const response = await appWithKeys().request('/v1/systemone', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong' },
  });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ message: 'Invalid API key', error_type: 'authentication_error' });
});
