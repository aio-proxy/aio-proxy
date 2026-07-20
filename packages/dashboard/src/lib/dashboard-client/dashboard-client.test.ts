import { afterEach, beforeEach, expect, rs, test } from "@rstest/core";

import "@/modules/auth/services/auth-service";
import { setDashboardAuthSession } from "@/modules/auth/services/auth-session-store";

import { createDashboardClient } from ".";
import { queryClient } from "../query-client";

beforeEach(() => {
  queryClient.clear();
});

afterEach(() => {
  rs.restoreAllMocks();
});

test.each(["authenticated", "disabled"] as const)(
  "dashboard unavailable clears a cached %s session's business queries",
  async (status) => {
    setDashboardAuthSession({ status });
    queryClient.setQueryData(["providers"], { providers: [{ id: "primary" }] });
    rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "dashboard_unavailable" }, { status: 503 }));

    const response = await createDashboardClient("http://localhost").dashboard.api.providers.$get();

    expect(response.status).toBe(503);
    expect(queryClient.getQueryData(["dashboard-auth"])).toEqual({ status: "unavailable" });
    expect(queryClient.getQueryData(["providers"])).toBeUndefined();
  },
);
