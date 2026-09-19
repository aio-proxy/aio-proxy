import { afterEach, expect, test } from '@rstest/core';

import {
  clearDashboardAuthToken,
  readDashboardAuthToken,
  subscribeDashboardAuthTokenCleared,
  writeDashboardAuthToken,
} from './dashboard-auth-token';

afterEach(() => {
  clearDashboardAuthToken();
  globalThis.sessionStorage.removeItem('aio-proxy.dashboard-session');
});

test('round-trips a stored Dashboard session token', () => {
  writeDashboardAuthToken('dashboard-session-token');

  expect(readDashboardAuthToken()).toBe('dashboard-session-token');
});

test('adopts a session left behind by the previous sessionStorage build', () => {
  globalThis.sessionStorage.setItem('aio-proxy.dashboard-session', 'legacy-token');

  expect(readDashboardAuthToken()).toBe('legacy-token');
  // Moved rather than copied, so the next read no longer depends on the legacy area.
  expect(globalThis.sessionStorage.getItem('aio-proxy.dashboard-session')).toBeNull();
  expect(readDashboardAuthToken()).toBe('legacy-token');
});

test('a legacy session never overrides a current one', () => {
  globalThis.sessionStorage.setItem('aio-proxy.dashboard-session', 'legacy-token');
  writeDashboardAuthToken('current-token');

  expect(readDashboardAuthToken()).toBe('current-token');
});

test('logging out leaves no legacy token behind to resurrect the session', () => {
  // A sibling tab reloaded first and populated the shared token, so this tab's own legacy copy was
  // never adopted — it has to be retired anyway, or the next reload would adopt it.
  globalThis.sessionStorage.setItem('aio-proxy.dashboard-session', 'legacy-token');
  writeDashboardAuthToken('shared-token');
  expect(readDashboardAuthToken()).toBe('shared-token');

  clearDashboardAuthToken();

  expect(readDashboardAuthToken()).toBeUndefined();
});

test('logging out discards a legacy token this tab never read', () => {
  globalThis.sessionStorage.setItem('aio-proxy.dashboard-session', 'legacy-token');

  clearDashboardAuthToken();

  expect(readDashboardAuthToken()).toBeUndefined();
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
  // A sibling tab calling `localStorage.clear()` reports a null key rather than the cleared one.
  globalThis.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null, storageArea: localStorage }));
  globalThis.dispatchEvent(
    new StorageEvent('storage', { key: 'aio-proxy.dashboard-session', newValue: 'renewed', storageArea: localStorage }),
  );
  globalThis.dispatchEvent(
    new StorageEvent('storage', { key: 'unrelated', newValue: null, storageArea: localStorage }),
  );

  expect(cleared).toBe(2);
});
