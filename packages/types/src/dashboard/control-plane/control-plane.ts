import { z } from 'zod';

import { ServerConfigSchema, ServerLoggingSchema, ServerRetrySchema } from '../../config/index';
import { DashboardOAuthFormFieldSchema } from '../../dashboard-oauth';
import { PluginPackageNameSchema, PluginStateSchema } from '../../plugin';
import { ConfigTemplateStringSchema, HttpProxyUrlSchema } from '../../provider';

const required = <T extends z.ZodType>(schema: z.ZodDefault<T>): T => schema.unwrap();

const DashboardSettingsProxySchema = z.union([
  HttpProxyUrlSchema.refine((value) => {
    try {
      const url = new URL(value);
      return url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'Dashboard settings cannot expose proxy credentials'),
  z.literal('****'),
  z.null(),
]);

const DashboardSettingsLoggingSchema = z.strictObject({
  enabled: required(ServerLoggingSchema.shape.enabled),
  retentionDays: required(ServerLoggingSchema.shape.retentionDays),
  level: required(ServerLoggingSchema.shape.level),
});

export const DashboardSettingsViewSchema = z.strictObject({
  host: required(ServerConfigSchema.shape.host),
  port: required(ServerConfigSchema.shape.port),
  proxy: DashboardSettingsProxySchema,
  logging: DashboardSettingsLoggingSchema,
  retryAfterCapMs: required(ServerRetrySchema.shape.retryAfterCapMs),
  hasPassword: z.boolean(),
});

export const DashboardSettingsMutationSchema = z.strictObject({
  host: required(ServerConfigSchema.shape.host).optional(),
  port: required(ServerConfigSchema.shape.port).optional(),
  proxy: z.union([HttpProxyUrlSchema, ConfigTemplateStringSchema, z.null()]).optional(),
  logging: z
    .strictObject({
      enabled: required(ServerLoggingSchema.shape.enabled).optional(),
      retentionDays: required(ServerLoggingSchema.shape.retentionDays).optional(),
      level: required(ServerLoggingSchema.shape.level).optional(),
    })
    .optional(),
  retryAfterCapMs: required(ServerRetrySchema.shape.retryAfterCapMs).optional(),
});

export const DashboardSettingsMutationErrorSchema = z.strictObject({
  code: z.enum(['config_unavailable', 'config_rejected', 'reload_failed']),
});

export const DashboardSettingsMutationResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    settings: DashboardSettingsViewSchema,
    restartRequired: z.boolean(),
  }),
  z.strictObject({ ok: z.literal(false), error: DashboardSettingsMutationErrorSchema }),
]);

export const DashboardPluginSummarySchema = z.strictObject({
  packageName: PluginPackageNameSchema,
  version: z.string().min(1).optional(),
  builtin: z.boolean(),
  enabled: z.boolean(),
  state: PluginStateSchema,
  hasOptions: z.boolean(),
});

export const DashboardPluginEditViewSchema = z
  .strictObject({
    packageName: PluginPackageNameSchema,
    form: z.array(DashboardOAuthFormFieldSchema),
    publicValues: z.record(z.string().min(1), z.json()),
    revision: z.string().min(1),
  })
  .superRefine((value, context) => {
    const secretKeys = new Set(value.form.filter((field) => field.type === 'secret').map((field) => field.key));
    for (const key of Object.keys(value.publicValues)) {
      if (secretKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'Secret values cannot appear in publicValues',
          path: ['publicValues', key],
        });
      }
    }
  });

export const DashboardPluginOptionsMutationSchema = z.strictObject({
  packageName: PluginPackageNameSchema,
  revision: z.string().min(1),
  publicValues: z.record(z.string().min(1), z.json()),
  secretValues: z.record(z.string().min(1), z.string().min(1)),
  clearSecretKeys: z.array(z.string().min(1)),
});

export type DashboardSettingsView = z.output<typeof DashboardSettingsViewSchema>;
export type DashboardSettingsMutationInput = z.input<typeof DashboardSettingsMutationSchema>;
export type DashboardSettingsMutation = z.output<typeof DashboardSettingsMutationSchema>;
export type DashboardSettingsMutationResponse = z.output<typeof DashboardSettingsMutationResponseSchema>;
export type DashboardPluginSummary = z.output<typeof DashboardPluginSummarySchema>;
export type DashboardPluginEditView = z.output<typeof DashboardPluginEditViewSchema>;
export type DashboardPluginOptionsMutationInput = z.input<typeof DashboardPluginOptionsMutationSchema>;
export type DashboardPluginOptionsMutation = z.output<typeof DashboardPluginOptionsMutationSchema>;
