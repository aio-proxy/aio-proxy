import { afterEach, expect, test } from '@rstest/core';

import {
  clearDashboardAuthToken,
  readDashboardAuthToken,
  subscribeDashboardAuthTokenCleared,
  writeDashboardAuthToken,
} from './dashboard-auth-token';

afterEach(() => {
  clearDashboardAuthToken();
});

test('round-trips a stored Dashboard session token', () => {
  writeDashboardAuthToken('dashboard-session-token');

  expect(readDashboardAuthToken()).toBe('dashboard-session-token');
});

test('clearing the token removes it from storage', () => {
  writeDashboardAuthToken('dashboard-session-token');
  clearDashboardAuthToken();

  expect(readDashboardAuthToken()).toBeUndefined();
});

test('notifies subscribers when another tab clears the session token', () => {
  writeDashboardAuthToken('cross-tab-token');
  let cleared = 0;
  subscribeDashboardAuthTokenCleared(() => {
    cleared += 1;
  });

  globalThis.dispatchEvent(
    new StorageEvent('storage', { key: 'aio-proxy.dashboard-session', newValue: null, storageArea: localStorage }),
  );
  globalThis.dispatchEvent(
    new StorageEvent('storage', { key: 'aio-proxy.dashboard-session', newValue: 'renewed', storageArea: localStorage }),
  );
  globalThis.dispatchEvent(
    new StorageEvent('storage', { key: 'unrelated', newValue: null, storageArea: localStorage }),
  );

  expect(cleared).toBe(1);
});
