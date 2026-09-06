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
  expect(body).toEqual({ current: '1.2.0', managedService: false, update: { status: 'idle' } });
});

test('POST /apply maps controller results to HTTP statuses', async () => {
  const table = [
    [{ status: 'started' as const }, 202, { ok: true, status: 'started' }],
    [{ status: 'up_to_date' as const }, 200, { ok: true, status: 'up_to_date' }],
    [{ status: 'in_progress' as const }, 409, { ok: false, error: { code: 'in_progress' } }],
    [{ status: 'unavailable' as const }, 501, { ok: false, error: { code: 'unavailable' } }],
    [{ status: 'check_failed' as const }, 502, { ok: false, error: { code: 'check_failed' } }],
  ] as const;
  for (const [result, status, body] of table) {
    const routes = createDashboardReleaseRoute('1.2.0', async () => '1.2.0', {
      isManagedService: () => true,
      snapshot: () => ({ status: 'idle' }),
      apply: async () => result,
      notifyCheck: () => {},
      start: () => {},
      stop: () => {},
    });
    const response = await routes.request('/apply', { method: 'POST' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  }
});

test('GET / reports managedService from the controller', async () => {
  const routes = createDashboardReleaseRoute('1.2.0', async () => '1.2.0', {
    isManagedService: () => true,
    snapshot: () => ({ status: 'in_progress' }),
    apply: async () => ({ status: 'in_progress' }),
    notifyCheck: () => {},
    start: () => {},
    stop: () => {},
  });
  const response = await routes.request('/');
  expect(await response.json()).toEqual({
    current: '1.2.0',
    managedService: true,
    update: { status: 'in_progress' },
  });
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
