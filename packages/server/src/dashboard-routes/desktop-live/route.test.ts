import { beforeEach, expect, mock, test } from 'bun:test';

import { readDesktopToken } from '@aio-proxy/core';
import { ConfigSchema, DesktopLiveV1Schema } from '@aio-proxy/types';

import { createServer, createServerState, createServerTestHome } from '#server-test-lifecycle';

import { loopbackServer } from '../../dashboard-auth/test-support';
import { createDesktopLiveRoute } from './index';

let dir: string;
beforeEach(() => {
  dir = createServerTestHome();
});

const peer = (address: string) => ({ requestIP: () => ({ address }) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, host: '127.0.0.1:9317' });
const serve = () =>
  createServer({
    config: { server: { port: 9_317 }, providers: {} },
    dbHome: dir,
    watchConfig: false,
  });

test('the desktop token reaches the registered live route', async () => {
  const app = await serve();
  const token = readDesktopToken(dir) ?? '';
  const response = await app.request('/dashboard/api/desktop-live', { headers: bearer(token) }, loopbackServer);
  expect(response.status).toBe(200);
  expect(DesktopLiveV1Schema.parse(await response.json())).toEqual({
    version: 1,
    todayTokens: '0',
    todayCostNanoUsd: '0',
    inFlight: 0,
    outputTokensPerSecond: 0,
  });
});

test('a missing or wrong token is refused', async () => {
  const app = await serve();
  expect(
    (await app.request('/dashboard/api/desktop-live', { headers: { host: '127.0.0.1:9317' } }, loopbackServer)).status,
  ).toBe(401);
  expect(
    (await app.request('/dashboard/api/desktop-live', { headers: bearer('B'.repeat(43)) }, loopbackServer)).status,
  ).toBe(401);
});

test.each(['192.168.1.20', '2001:db8::1', 'fe80::1', '::ffff:192.168.1.20'])(
  'non-loopback peer %s is refused even when headers claim loopback',
  async (address) => {
    const app = await serve();
    const token = readDesktopToken(dir) ?? '';
    const response = await app.request(
      '/dashboard/api/desktop-live',
      { headers: { ...bearer(token), origin: 'http://127.0.0.1:9317', 'x-forwarded-for': '127.0.0.1' } },
      peer(address),
    );
    expect(response.status).toBe(401);
  },
);

const fixture = async (initialNow = new Date(2026, 9, 5, 12)) => {
  const state = await createServerState({
    config: ConfigSchema.parse({ server: { port: 9_317 }, providers: {} }),
    dbHome: dir,
    watchConfig: false,
  });
  let now = initialNow;
  const todayUsage = mock((_now: Date) => ({
    inputTokens: 9007199254740993n,
    outputTokens: 7n,
    estimatedCostNanoUsd: 9223372036854775808n,
  }));
  const snapshot = mock(() => ({ inFlight: 3, outputTokensPerSecond: 12.36 }));
  const app = createDesktopLiveRoute(
    {
      desktopToken: state.desktopToken,
      traceStore: { ...state.traceStore, todayUsage },
      liveMetrics: { ...state.liveMetrics, snapshot },
    },
    { now: () => now },
  );
  return {
    todayUsage,
    snapshot,
    setNow: (value: Date) => {
      now = value;
    },
    get: async () => {
      const response = await app.request('/', { headers: bearer(state.desktopToken ?? '') }, loopbackServer);
      expect(response.status).toBe(200);
      return DesktopLiveV1Schema.parse(await response.json());
    },
  };
};

test('serializes exact bigint totals and rounds the live snapshot to one decimal', async () => {
  const { get, todayUsage, snapshot } = await fixture();
  expect(await get()).toEqual({
    version: 1,
    todayTokens: '9007199254741000',
    todayCostNanoUsd: '9223372036854775808',
    inFlight: 3,
    outputTokensPerSecond: 12.4,
  });
  expect(todayUsage).toHaveBeenCalledWith(new Date(2026, 9, 5, 12));
  snapshot.mockReturnValue({ inFlight: 1, outputTokensPerSecond: 7.24 });
  const second = await get();
  expect(second.inFlight).toBe(1);
  expect(second.outputTokensPerSecond).toBe(7.2);
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(todayUsage).toHaveBeenCalledTimes(1);
});

test('caches today totals for five seconds and queries again at the sixth second', async () => {
  const { get, setNow, todayUsage } = await fixture();
  await get();
  setNow(new Date(2026, 9, 5, 12, 0, 4, 999));
  await get();
  expect(todayUsage).toHaveBeenCalledTimes(1);
  todayUsage.mockReturnValue({ inputTokens: 20n, outputTokens: 30n, estimatedCostNanoUsd: 40n });
  setNow(new Date(2026, 9, 5, 12, 0, 6));
  expect(await get()).toMatchObject({ todayTokens: '50', todayCostNanoUsd: '40' });
  expect(todayUsage).toHaveBeenCalledTimes(2);
});

test('expires the cache exactly at five seconds', async () => {
  const { get, setNow, todayUsage } = await fixture();
  await get();
  setNow(new Date(2026, 9, 5, 12, 0, 5));
  await get();
  expect(todayUsage).toHaveBeenCalledTimes(2);
});

test('queries immediately across local midnight even within the cache lifetime', async () => {
  const { get, setNow, todayUsage } = await fixture(new Date(2026, 9, 5, 23, 59, 59));
  await get();
  todayUsage.mockReturnValue({ inputTokens: 0n, outputTokens: 0n, estimatedCostNanoUsd: 0n });
  const midnight = new Date(2026, 9, 6, 0, 0, 0);
  setNow(midnight);
  expect(await get()).toMatchObject({ todayTokens: '0', todayCostNanoUsd: '0' });
  expect(todayUsage).toHaveBeenCalledTimes(2);
  expect(todayUsage).toHaveBeenLastCalledWith(midnight);
});

test('invalidates the cache when the clock rolls back between polls', async () => {
  const { get, setNow, todayUsage } = await fixture();
  await get();
  setNow(new Date(2026, 9, 5, 12, 0, 4));
  await get();
  expect(todayUsage).toHaveBeenCalledTimes(1);
  setNow(new Date(2026, 9, 5, 12, 0, 3));
  await get();
  expect(todayUsage).toHaveBeenCalledTimes(2);
});
