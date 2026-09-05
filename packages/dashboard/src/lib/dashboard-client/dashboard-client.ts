import type { AppType } from '@aio-proxy/server';
import { hc } from 'hono/client';

import { readDashboardAuthToken } from '@/lib/dashboard-auth-token';

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
