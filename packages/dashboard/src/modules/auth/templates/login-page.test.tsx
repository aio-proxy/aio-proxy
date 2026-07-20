import { expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LoginPage } from "./login-page";

const mocks = rs.hoisted(() => ({ loginDashboard: rs.fn() }));

rs.mock("@aio-proxy/i18n", () => ({
  m: {
    common_loading: () => "Loading",
    "brand.name": () => "AIO Proxy",
    "brand.tagline": () => "All-in-one Gateway",
    "dashboard.auth.login.description": () => "Enter the configured password.",
    "dashboard.auth.login.expired": () => "Your session expired. Sign in again.",
    "dashboard.auth.login.invalid": () => "Incorrect password.",
    "dashboard.auth.login.password_required": () => "Enter your password.",
    "dashboard.auth.login.rate_limited": () => "Too many attempts.",
    "dashboard.auth.login.submit": () => "Sign in",
    "dashboard.auth.login.title": () => "Dashboard sign in",
    "dashboard.auth.password": () => "Password",
  },
}));

rs.mock("../services/auth-service", () => ({ loginDashboard: mocks.loginDashboard }));

test("submits the exact password after an expired session", async () => {
  mocks.loginDashboard.mockResolvedValue({ ok: true });
  render(<LoginPage reason="expired" />);

  expect(screen.getByText("Your session expired. Sign in again.")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "  exact password  " } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  await waitFor(() => expect(mocks.loginDashboard).toHaveBeenCalledWith("  exact password  "));
});

test("shows a field error for an empty password", async () => {
  mocks.loginDashboard.mockClear();
  render(<LoginPage />);

  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(await screen.findByText("Enter your password.")).toBeInTheDocument();
  expect(mocks.loginDashboard).not.toHaveBeenCalled();
});
