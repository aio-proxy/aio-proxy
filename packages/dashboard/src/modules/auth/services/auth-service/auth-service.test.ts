import { beforeEach, expect, rs, test } from "@rstest/core";

import { queryClient } from "@/lib/query-client";

import { setDashboardAuthSession } from "../auth-session-store";
import { loginDashboard } from "./auth-service";

const mocks = rs.hoisted(() => ({
  login: rs.fn(),
  unauthorized: undefined as (() => void) | undefined,
}));

rs.mock("@/lib/dashboard-client", () => ({
  dashboardClient: {
    dashboard: { api: { auth: { login: { $post: mocks.login } } } },
  },
  setDashboardUnauthorizedHandler: (handler: () => void) => {
    mocks.unauthorized = handler;
  },
}));

beforeEach(() => {
  queryClient.clear();
  mocks.login.mockReset();
});

test("a business API 401 transitions a cached disabled session to unauthenticated", () => {
  setDashboardAuthSession({ status: "disabled" });

  mocks.unauthorized?.();

  expect(queryClient.getQueryData(["dashboard-auth"])).toEqual({ status: "unauthenticated" });
});

test("login 409 transitions the cached session back to disabled", async () => {
  setDashboardAuthSession({ status: "unauthenticated" });
  mocks.login.mockResolvedValue({ status: 409 });

  await loginDashboard("password");

  expect(queryClient.getQueryData(["dashboard-auth"])).toEqual({ status: "disabled" });
});

test("a rejected login request returns the unavailable feedback result", async () => {
  mocks.login.mockRejectedValue(new Error("offline"));

  await expect(loginDashboard("password")).resolves.toEqual({ ok: false, error: "unknown" });
});
