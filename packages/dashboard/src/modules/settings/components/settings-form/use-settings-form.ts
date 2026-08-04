import type { DashboardSettingsView } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';

export const settingsFormValues = (settings: DashboardSettingsView) => ({
  host: settings.host,
  logging: settings.logging,
  port: settings.port,
  proxy: settings.proxy ?? '',
  retryAfterCapSeconds: settings.retryAfterCapMs / 1_000,
});

export const useSettingsForm = (settings: DashboardSettingsView) =>
  useForm({
    defaultValues: settingsFormValues(settings),
  });

export type SettingsFormApi = ReturnType<typeof useSettingsForm>;
