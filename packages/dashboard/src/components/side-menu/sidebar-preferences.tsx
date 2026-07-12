import { getLocale, type Locale, m, setLocale } from "@aio-proxy/i18n";
import { Languages, MonitorCog } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarFooter, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { reloadDashboard } from "./reload-dashboard";

const themes = [
  ["system", () => m["dashboard.preferences.theme_system"]()],
  ["light", () => m["dashboard.preferences.theme_light"]()],
  ["dark", () => m["dashboard.preferences.theme_dark"]()],
] as const;

const languages = [
  ["zh-Hans", () => m["dashboard.preferences.language_zh_hans"]()],
  ["en", () => m["dashboard.preferences.language_en"]()],
] as const;

export const SidebarPreferences: React.FC = () => {
  const { theme = "system", setTheme } = useTheme();

  const changeLocale = async (locale: Locale) => {
    if (locale === getLocale()) return;
    await setLocale(locale);
    reloadDashboard();
  };

  return (
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton />}>
              <MonitorCog />
              <span>{m["dashboard.preferences.appearance"]()}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end">
              <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value)}>
                {themes.map(([value, label]) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {label()}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton />}>
              <Languages />
              <span>{m["dashboard.preferences.language"]()}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end">
              <DropdownMenuRadioGroup value={getLocale()} onValueChange={(value) => void changeLocale(value as Locale)}>
                {languages.map(([value, label]) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {label()}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
};
