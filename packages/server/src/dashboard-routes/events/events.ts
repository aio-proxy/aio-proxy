import { Hono } from "hono";

import type { DashboardAuthentication } from "../../dashboard-auth";
import type { ServerState } from "../../server-state";

import { dashboardSessionToken } from "../../dashboard-auth";

export const createDashboardEventsRoute = (state: ServerState, auth: DashboardAuthentication) =>
  new Hono().get("/", (context) => {
    const token = dashboardSessionToken(context);
    return new Response(
      state.events.stream(() => auth.available() && (!auth.enabled() || auth.verify(token))),
      {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream; charset=utf-8",
        },
      },
    );
  });
