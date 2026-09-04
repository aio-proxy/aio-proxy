import { expect, test } from 'bun:test';

import { createDashboardReleaseRoute } from './release';

const get = async (path: string, latest: () => Promise<string>) => {
  const routes = createDashboardReleaseRoute('1.2.0', latest);
  const response = await routes.request(path);
  return { body: await response.json(), status: response.status };
};

test('reports the running version without touching the registry', async () => {
  const { body, status } = await get('/', () => Promise.reject(new Error('must not be called')));

  expect(status).toBe(200);
  expect(body).toEqual({ current: '1.2.0' });
});

test('flags a newer published version as outdated', async () => {
  const { body } = await get('/latest', () => Promise.resolve('1.10.0'));

  // String comparison would rank 1.10.0 below 1.2.0 and hide the upgrade.
  expect(body).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
});

test('does not flag an older or equal published version', async () => {
  expect(await get('/latest', () => Promise.resolve('1.2.0')).then((result) => result.body)).toMatchObject({
    outdated: false,
  });
  expect(await get('/latest', () => Promise.resolve('1.1.9')).then((result) => result.body)).toMatchObject({
    outdated: false,
  });
});

test('reports a failed registry lookup instead of claiming the build is current', async () => {
  const { body, status } = await get('/latest', () => Promise.reject(new Error('offline')));

  expect(status).toBe(502);
  expect(body).toEqual({ error: { code: 'check_failed' } });
});
