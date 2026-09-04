import {
  type DashboardSettingsMutationInput,
  DashboardSettingsMutationSchema,
  type DashboardSettingsView,
} from '@aio-proxy/types';

export interface SettingsFormProps {
  readonly settings: DashboardSettingsView;
}

export interface PendingAccessChange {
  readonly field: 'host' | 'port';
  readonly input: DashboardSettingsMutationInput;
}

/** A field that owns a secret draft clears it from `onSuccess`, never optimistically. */
export type SettingsSave = (
  input: DashboardSettingsMutationInput,
  options?: { readonly onSuccess?: () => void },
) => void;

export const hostSchema = DashboardSettingsMutationSchema.shape.host.unwrap();
export const portSchema = DashboardSettingsMutationSchema.shape.port.unwrap();
const loggingSchema = DashboardSettingsMutationSchema.shape.logging.unwrap();
export const retentionSchema = loggingSchema.shape.retentionDays.unwrap();
export const levelSchema = loggingSchema.shape.level.unwrap();
export const retrySchema = DashboardSettingsMutationSchema.shape.retryAfterCapMs.unwrap();
export const proxySchema = DashboardSettingsMutationSchema.shape.proxy.unwrap();
export const passwordSchema = DashboardSettingsMutationSchema.shape.password.unwrap();
export const apiKeysSchema = DashboardSettingsMutationSchema.shape.apiKeys.unwrap();
