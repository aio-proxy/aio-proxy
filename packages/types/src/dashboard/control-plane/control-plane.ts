import { z } from 'zod';

import { ServerConfigSchema, ServerLoggingSchema, ServerRetrySchema } from '../../config/index';
import { DashboardLocalizedTextSchema } from '../../dashboard-localized-text';
import { DashboardOAuthFormFieldSchema } from '../../dashboard-oauth';
import { PluginPackageNameSchema, PluginStateSchema } from '../../plugin';
import { ConfigTemplateStringSchema, HttpProxyUrlSchema } from '../../provider';

const required = <T extends z.ZodType>(schema: z.ZodDefault<T>): T => schema.unwrap();

const CONFIG_TEMPLATE_EXPRESSION = /(?<![\\{])\{\{[\t\n\r ]*env\.[A-Za-z_][A-Za-z0-9_]*[\t\n\r ]*\}\}(?!\})/gu;

function hasOnlySupportedConfigTemplates(value: string): boolean {
  let expressions = 0;
  const literal = value.replace(CONFIG_TEMPLATE_EXPRESSION, () => {
    expressions += 1;
    return '';
  });
  return expressions > 0 && !literal.includes('{{');
}

function materializeProxyTemplate(value: string): string {
  const authorityStart = value.indexOf('://') + 3;
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd = authorityEndOffset < 0 ? value.length : authorityStart + authorityEndOffset;
  const hostStart = Math.max(authorityStart, value.lastIndexOf('@', authorityEnd - 1) + 1);
  const bracketed = value[hostStart] === '[';
  const bracketEnd = bracketed ? value.indexOf(']', hostStart + 1) : -1;
  let portSeparator = value.lastIndexOf(':', authorityEnd - 1);
  if (bracketed) {
    portSeparator = -1;
    if (bracketEnd >= 0 && value[bracketEnd + 1] === ':') portSeparator = bracketEnd + 1;
  }
  const hostValueStart = bracketed ? hostStart + 1 : hostStart;
  let hostEnd = authorityEnd;
  if (portSeparator > hostStart) hostEnd = portSeparator;
  if (bracketed && bracketEnd >= 0) hostEnd = bracketEnd;

  return value.replace(CONFIG_TEMPLATE_EXPRESSION, (expression, offset: number) => {
    const expressionEnd = offset + expression.length;
    if (offset >= hostValueStart && expressionEnd <= hostEnd) {
      const replacesHost = offset === hostValueStart && expressionEnd === hostEnd;
      if (bracketed) return replacesHost ? '2001:db8::1' : '1';
      return replacesHost ? 'proxy.example' : 'value';
    }
    if (portSeparator >= 0 && offset > portSeparator && expressionEnd <= authorityEnd) {
      const replacesPort = offset === portSeparator + 1 && expressionEnd === authorityEnd;
      return replacesPort ? '8080' : '0';
    }
    return 'value';
  });
}

const DashboardHttpProxyTemplateSchema = ConfigTemplateStringSchema.pipe(
  z
    .string()
    .refine(hasOnlySupportedConfigTemplates, 'Unsupported config template')
    .refine(
      (value) => HttpProxyUrlSchema.safeParse(materializeProxyTemplate(value)).success,
      'Proxy template must have a valid http: or https: URL shape',
    ),
);

const DashboardHttpProxyUrlSchema = HttpProxyUrlSchema.refine(
  (value) => !value.includes('{{'),
  'Proxy URLs containing templates must use supported config template expressions',
);

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

const DashboardPasswordSchema = z
  .string()
  .min(8)
  .describe('New dashboard password in plaintext; the server stores only an Argon2id hash.');

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
  proxy: z.union([DashboardHttpProxyUrlSchema, DashboardHttpProxyTemplateSchema, z.null()]).optional(),
  password: z.union([DashboardPasswordSchema, z.null()]).optional(),
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
  displayName: DashboardLocalizedTextSchema.optional(),
  icon: z.string().min(1).optional(),
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
