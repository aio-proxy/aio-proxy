import { describe, expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SidebarPreferences } from "./sidebar-preferences";

const mocks = rs.hoisted(() => ({
  reloadDashboard: rs.fn(),
  setLocale: rs.fn().mockResolvedValue(undefined),
  setTheme: rs.fn(),
}));

rs.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: mocks.setTheme }),
}));

rs.mock("@aio-proxy/i18n", () => ({
  getLocale: () => "en",
  setLocale: mocks.setLocale,
  m: {
    "dashboard.preferences.appearance": () => "Appearance",
    "dashboard.preferences.language": () => "Language",
    "dashboard.preferences.theme_system": () => "System",
    "dashboard.preferences.theme_light": () => "Light",
    "dashboard.preferences.theme_dark": () => "Dark",
    "dashboard.preferences.language_zh_hans": () => "简体中文",
    "dashboard.preferences.language_en": () => "English",
  },
}));

rs.mock("./reload-dashboard", () => ({ reloadDashboard: mocks.reloadDashboard }));

const renderPreferences = () =>
  render(
    <SidebarProvider>
      <SidebarPreferences />
    </SidebarProvider>,
  );

describe("sidebar preferences", () => {
  test("changes the appearance from the sidebar footer", async () => {
    renderPreferences();

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Dark" }));

    expect(mocks.setTheme).toHaveBeenCalledWith("dark");
  });

  test("stores a different language and reloads the dashboard", async () => {
    renderPreferences();

    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "简体中文" }));

    await waitFor(() => {
      expect(mocks.setLocale).toHaveBeenCalledWith("zh-Hans");
      expect(mocks.reloadDashboard).toHaveBeenCalledTimes(1);
    });
  });
});
