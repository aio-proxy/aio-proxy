import type { AppType } from "@aio-proxy/server";
import { hc } from "hono/client";

export const createDashboardClient = (baseUrl = "") => hc<AppType>(baseUrl);

export const dashboardClient = createDashboardClient("");
