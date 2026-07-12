import { describe, expect, test } from "bun:test";

const preferencesPath = `${import.meta.dir}/../src/components/side-menu/sidebar-preferences.tsx`;
const sideMenuPath = `${import.meta.dir}/../src/components/side-menu/side-menu.tsx`;
const enPath = `${import.meta.dir}/../../i18n/messages/en.json`;
const zhPath = `${import.meta.dir}/../../i18n/messages/zh-Hans.json`;

describe("sidebar preferences", () => {
  test("renders persistent appearance and language menus in the sidebar footer", async () => {
    const [preferences, sideMenu, en, zh] = await Promise.all([
      Bun.file(preferencesPath).text(),
      Bun.file(sideMenuPath).text(),
      Bun.file(enPath).json(),
      Bun.file(zhPath).json(),
    ]);

    expect(sideMenu).toContain("<SidebarPreferences />");
    expect(preferences).toContain("<SidebarFooter>");
    expect(preferences).toContain("setTheme(value)");
    expect(preferences).toContain("await setLocale(locale)");
    expect(preferences).toContain("window.location.reload()");
    expect(en.dashboard.preferences.appearance).toBe("Appearance");
    expect(en.dashboard.preferences.language).toBe("Language");
    expect(zh.dashboard.preferences.appearance).toBe("外观");
    expect(zh.dashboard.preferences.language).toBe("语言");
  });
});
