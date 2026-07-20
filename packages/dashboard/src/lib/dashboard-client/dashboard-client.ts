import type { AppType } from "@aio-proxy/server";

import { hc } from "hono/client";

let handleDashboardUnauthorized = (): void => {};
let handleDashboardUnavailable = (): void => {};

export function setDashboardUnauthorizedHandler(handler: () => void): void {
  handleDashboardUnauthorized = handler;
}

export function setDashboardUnavailableHandler(handler: () => void): void {
  handleDashboardUnavailable = handler;
}

const dashboardFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) handleDashboardUnauthorized();
  if (await isDashboardUnavailable(response)) handleDashboardUnavailable();
  return response;
};

async function isDashboardUnavailable(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const body = (await response.clone().json()) as { readonly error?: unknown };
    return body.error === "dashboard_unavailable";
  } catch {
    return false;
  }
}

export const createDashboardClient = (baseUrl = "") => hc<AppType>(baseUrl, { fetch: dashboardFetch });

export const dashboardClient = createDashboardClient("");
