import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AutoUpdateController } from '../../auto-update';
import { createDashboardReleaseRoute } from './release';

const originalHome = process.env.AIO_PROXY_HOME;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = originalHome;
});

const isolateHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-release-'));
  homes.push(home);
  process.env.AIO_PROXY_HOME = home;
};

const idleController = (overrides: Partial<AutoUpdateController> = {}): AutoUpdateController => ({
  isManagedService: () => false,
  snapshot: () => ({ status: 'idle', outdated: false }),
  check: async () => ({ status: 'check_failed' }),
  apply: async () => ({ status: 'unavailable' }),
  start: () => {},
  stop: () => {},
  ...overrides,
});

const get = async (path: string, latest: () => Promise<string>) => {
  const routes = createDashboardReleaseRoute('1.2.0', latest);
  const response = await routes.request(path);
  return { body: await response.json(), status: response.status };
};

test('reports the running version without touching the registry', async () => {
  const { body, status } = await get('/', () => Promise.reject(new Error('must not be called')));

  expect(status).toBe(200);
  expect(body).toEqual({ current: '1.2.0', outdated: false, managedService: false, update: { status: 'idle' } });
});

test('GET / exposes persisted latest from the controller snapshot', async () => {
  const routes = createDashboardReleaseRoute(
    '1.2.0',
    async () => {
      throw new Error('must not be called');
    },
    idleController({
      isManagedService: () => true,
      snapshot: () => ({ status: 'idle', latest: '1.10.0', outdated: true }),
    }),
  );
  const response = await routes.request('/');
  expect(await response.json()).toEqual({
    current: '1.2.0',
    latest: '1.10.0',
    outdated: true,
    managedService: true,
    update: { status: 'idle' },
  });
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
    const routes = createDashboardReleaseRoute(
      '1.2.0',
      async () => '1.2.0',
      idleController({ apply: async () => result }),
    );
    const response = await routes.request('/apply', { method: 'POST' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  }
});

test('GET /latest uses controller.check and persists through it', async () => {
  const routes = createDashboardReleaseRoute(
    '1.2.0',
    async () => {
      throw new Error('must not fetch when the controller is present');
    },
    idleController({
      check: async () => ({ current: '1.2.0', latest: '1.10.0', outdated: true }),
    }),
  );
  const response = await routes.request('/latest');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
});

test('flags a newer published version as outdated', async () => {
  isolateHome();
  const { body } = await get('/latest', () => Promise.resolve('1.10.0'));

  expect(body).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
});

test('does not flag an older or equal published version', async () => {
  isolateHome();
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
