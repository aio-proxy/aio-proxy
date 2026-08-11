import type { AppType } from '@aio-proxy/server';
import { hc } from 'hono/client';

import { readDashboardAuthToken } from '@/modules/auth/services/dashboard-auth-token';

let handleDashboardUnauthorized = (): void => {};
let handleDashboardUnavailable = (): void => {};

export function setDashboardUnauthorizedHandler(handler: () => void): void {
  handleDashboardUnauthorized = handler;
}

export function setDashboardUnavailableHandler(handler: () => void): void {
  handleDashboardUnavailable = handler;
}

const dashboardFetch = (async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, globalThis.location?.origin);
  const token = readDashboardAuthToken();
  const shouldAuthenticate = url.pathname.startsWith('/dashboard/api/') && url.pathname !== '/dashboard/api/auth/login';
  const headers = new Headers(init?.headers ?? (typeof input === 'string' ? undefined : input.headers));
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

export const createDashboardClient = (baseUrl = '') => hc<AppType>(baseUrl, { fetch: dashboardFetch });

export const dashboardClient = createDashboardClient('');
