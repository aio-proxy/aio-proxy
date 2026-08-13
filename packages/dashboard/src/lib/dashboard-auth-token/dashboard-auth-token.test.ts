import { afterEach, expect, test } from '@rstest/core';

import { clearDashboardAuthToken, readDashboardAuthToken, writeDashboardAuthToken } from './dashboard-auth-token';

afterEach(() => {
  clearDashboardAuthToken();
});

test('round-trips a stored Dashboard session token', () => {
  writeDashboardAuthToken('dashboard-session-token');

  expect(readDashboardAuthToken()).toBe('dashboard-session-token');
});

test('clearing the token removes it from session storage', () => {
  writeDashboardAuthToken('dashboard-session-token');
  clearDashboardAuthToken();

  expect(readDashboardAuthToken()).toBeUndefined();
});
