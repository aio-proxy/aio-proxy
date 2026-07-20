import type { AppType } from "@aio-proxy/server";

import { hc } from "hono/client";

let handleDashboardUnauthorized = (): void => {};

export function setDashboardUnauthorizedHandler(handler: () => void): void {
  handleDashboardUnauthorized = handler;
}

const dashboardFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) handleDashboardUnauthorized();
  return response;
};

export const createDashboardClient = (baseUrl = "") => hc<AppType>(baseUrl, { fetch: dashboardFetch });

export const dashboardClient = createDashboardClient("");
