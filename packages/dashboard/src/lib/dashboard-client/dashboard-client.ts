import type { AppType } from '@aio-proxy/server';
import { hc } from 'hono/client';

import { readDashboardAuthToken, writeDashboardAuthToken } from '@/lib/dashboard-auth-token';

let handleDashboardUnauthorized = (): void => {};
let handleDashboardUnavailable = (): void => {};

/**
 * Tokens this client wrote as renewals. A concurrent request can renew the shared token while another
 * is still in flight, which would otherwise look indistinguishable from a replacement login and
 * silently suppress that request's 401 or 503 handling. Only a few can be outstanding at once, so a
 * short window is enough; renewals are all valid under the same key and last-write-wins.
 */
const renewalsWritten: string[] = [];

function recordRenewal(token: string): void {
  renewalsWritten.push(token);
  if (renewalsWritten.length > 8) renewalsWritten.shift();
}

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
  if (renewed !== null && renewed !== '' && stored !== undefined) {
    writeDashboardAuthToken(renewed);
    recordRenewal(renewed);
  }
  // Storage is shared across tabs, so the session may have been replaced while this request was in
  // flight. Tearing down on a response the current session never produced would let one tab's stale
  // 401 clear a login another tab had just completed. A renewal of this same session is not such a
  // replacement, so it must not suppress teardown — otherwise a sibling request's renewal would
  // swallow a real 401 and leave the tab looking authenticated.
  if (stored !== token && !(stored !== undefined && renewalsWritten.includes(stored))) return response;
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
