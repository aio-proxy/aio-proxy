import type { DashboardSettingsView } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';

export const useSettingsForm = (settings: DashboardSettingsView) =>
  useForm({
    defaultValues: {
      host: settings.host,
      logging: settings.logging,
      port: settings.port,
      proxy: settings.proxy ?? '',
      retryAfterCapSeconds: settings.retryAfterCapMs / 1_000,
    },
  });

export type SettingsFormApi = ReturnType<typeof useSettingsForm>;
