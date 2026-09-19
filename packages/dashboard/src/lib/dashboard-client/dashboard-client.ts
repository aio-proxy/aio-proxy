import type { AppType } from '@aio-proxy/server';
import { hc } from 'hono/client';

import { readDashboardAuthToken, writeDashboardAuthToken } from '@/lib/dashboard-auth-token';

let handleDashboardUnauthorized = (): void => {};
let handleDashboardUnavailable = (): void => {};

export function setDashboardUnauthorizedHandler(handler: () => void): void {
  handleDashboardUnauthorized = handler;
}

export function setDashboardUnavailableHandler(handler: () => void): void {
  handleDashboardUnavailable = handler;
}

const dashboardFetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input, globalThis.location?.origin);
  const token = readDashboardAuthToken();
  const shouldAuthenticate = url.pathname.startsWith('/dashboard/api/') && url.pathname !== '/dashboard/api/auth/login';
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (shouldAuthenticate && token !== undefined) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  const renewed = response.headers.get('x-dashboard-session-refresh');
  // Re-read rather than reuse `token`: a logout during this request already cleared storage, and
  // writing here would resurrect the session the user just ended.
  const stored = readDashboardAuthToken();
  // Renew only the session this request was actually sent with. Storage is shared across tabs and
  // can change mid-flight: a logout must not be undone, and a login completed after a password
  // change must not be overwritten by a renewal signed under the old hash, which would leave every
  // tab holding a token the server rejects. Skipping a renewal costs nothing — the next request
  // renews again.
  if (renewed !== null && renewed !== '' && token !== undefined && stored === token) {
    writeDashboardAuthToken(renewed);
  }
  // The teardown handlers run unconditionally. Suppressing them when storage no longer matches was
  // tried and withdrawn: a token string cannot distinguish a replacement login from a routine
  // renewal, least of all one written by another tab, so the guard swallowed genuine 401s and 503s
  // and left tabs authenticated on dead sessions. Acting on a stale response can at worst log the
  // user out a second time, which is the safe direction to fail.
  if (response.status === 401) handleDashboardUnauthorized();
  if (await isDashboardUnavailable(response)) handleDashboardUnavailable();
  return response;
}) as typeof fetch;

async function isDashboardUnavailable(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const body = (await response.clone().json()) as { readonly error?: unknown };
    return body.error === 'dashboard_unavailable';
  } catch {
    return false;
  }
}

/**
 * The subset of a response that service error helpers actually read. Hono's `ClientResponse` is not
 * assignable to the global `Response` (bun-types adds members to it that hono does not model), so
 * helpers that only inspect status and body must not ask for the full interface.
 */
export interface DashboardClientResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export const createDashboardClient = (baseUrl = '') => hc<AppType>(baseUrl, { fetch: dashboardFetch });

export const dashboardClient = createDashboardClient('');
