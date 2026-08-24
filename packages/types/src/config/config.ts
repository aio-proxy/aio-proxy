import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import type { InvalidProviderConfig } from '../plugin';
import { PluginPackageNameSchema } from '../plugin';
import {
  AiSdkProviderAuthoringSchema,
  AiSdkProviderSchema,
  ApiProviderAuthoringObjectSchema,
  ApiProviderObjectSchema,
  ConfigTemplateStringSchema,
  HttpProxyUrlSchema,
  OAuthProviderAuthoringSchema,
  OAuthProviderSchema,
  type Provider,
  ProviderKind,
  ProviderSchema,
  validateAliasTargets,
  validateApiEndpoints,
} from '../provider';

const ServerHostSchema = z.string().min(1);

const ApiKeySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1).optional(),
});

const ApiKeyAuthoringSchema = z.object({
  key: z.union([z.string().min(1), ConfigTemplateStringSchema]),
  label: z.string().min(1).optional(),
});

export const ServerLoggingSchema = z.object({
  enabled: z.boolean().default(false),
  dir: z.string().min(1).optional(),
  retentionDays: z.number().int().min(1).max(365).default(3),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const ServerRetrySchema = z.object({
  retryAfterCapMs: z
    .number()
    .int()
    .min(0)
    .max(300_000)
    .default(30_000)
    .describe('Upper bound on an honored 429 Retry-After cooldown, in milliseconds.'),
});

const ServerLoggingAuthoringSchema = ServerLoggingSchema.omit({ dir: true, level: true }).extend({
  dir: z.union([z.string().min(1), ConfigTemplateStringSchema]).optional(),
  level: z.union([z.enum(['debug', 'info', 'warn', 'error']), ConfigTemplateStringSchema]).default('info'),
});

export const ServerConfigSchema = z.object({
  host: ServerHostSchema.default('127.0.0.1').describe('Host for the proxy API server.'),
  port: z.number().int().min(1).max(65_535).default(9_317).describe('HTTP port for the proxy API server.'),
  apiKeys: z.array(ApiKeySchema).default([]).describe('Caller API keys for the proxy API server.'),
  password: z.string().min(1).optional().describe('Dashboard password or Argon2id PHC hash.'),
  logging: ServerLoggingSchema.prefault({}).optional(),
  retry: ServerRetrySchema.prefault({}),
});

const ServerConfigAuthoringSchema = ServerConfigSchema.omit({ host: true, logging: true, apiKeys: true }).extend({
  host: z
    .union([ServerHostSchema, ConfigTemplateStringSchema])
    .default('127.0.0.1')
    .describe('Host for the proxy API server.'),
  apiKeys: z.array(ApiKeyAuthoringSchema).default([]).describe('Caller API keys for the proxy API server.'),
  logging: ServerLoggingAuthoringSchema.prefault({}).optional(),
});

const ProviderInputValueSchema = z
  .discriminatedUnion('kind', [
    ApiProviderObjectSchema.omit({ id: true }),
    OAuthProviderSchema.omit({ id: true }),
    AiSdkProviderSchema.omit({ id: true }),
  ])
  .superRefine(validateAliasTargets)
  .superRefine(validateApiEndpoints);

const ProviderAuthoringInputValueSchema = z
  .discriminatedUnion('kind', [
    ApiProviderAuthoringObjectSchema.omit({ id: true }),
    OAuthProviderAuthoringSchema.omit({ id: true }),
    AiSdkProviderAuthoringSchema.omit({ id: true }),
  ])
  .superRefine(validateAliasTargets)
  .superRefine(validateApiEndpoints);

const PluginPackageNameAuthoringSchema = z.union([PluginPackageNameSchema, ConfigTemplateStringSchema]);

const PluginEnablementSchema = z
  .union([PluginPackageNameSchema, z.tuple([PluginPackageNameSchema, z.unknown()])])
  .transform((entry) =>
    typeof entry === 'string' ? { packageName: entry } : { packageName: entry[0], options: entry[1] },
  );

const PluginEnablementAuthoringSchema = z
  .union([PluginPackageNameAuthoringSchema, z.tuple([PluginPackageNameAuthoringSchema, z.unknown()])])
  .transform((entry) =>
    typeof entry === 'string' ? { packageName: entry } : { packageName: entry[0], options: entry[1] },
  );

function refineUniquePlugins(plugins: readonly { readonly packageName: string }[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, plugin] of plugins.entries()) {
    if (seen.has(plugin.packageName)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate plugin ${plugin.packageName}`,
        path: [index],
      });
    }
    seen.add(plugin.packageName);
  }
}

export const PluginsInputSchema = z.array(PluginEnablementSchema).default([]).superRefine(refineUniquePlugins);

const PluginsAuthoringInputSchema = z
  .array(PluginEnablementAuthoringSchema)
  .default([])
  .superRefine(refineUniquePlugins);

const CONFIG_PROXY_DESCRIPTION = 'Default HTTP(S) proxy URL inherited by providers that omit their own proxy.';

export const ModelContextAggregation = { Min: 'min', Max: 'max' } as const;

export const RouterConfigSchema = z.object({
  modelContextAggregation: z
    .enum([ModelContextAggregation.Min, ModelContextAggregation.Max])
    .default(ModelContextAggregation.Min)
    .describe('How to reconcile a public slug context window across providers: min (safe) or max.'),
});

export const ConfigAuthoringSchema = z.object({
  server: ServerConfigAuthoringSchema.prefault({}).describe('Local server settings.'),
  plugins: PluginsAuthoringInputSchema,
  proxy: z.union([HttpProxyUrlSchema, ConfigTemplateStringSchema]).optional().describe(CONFIG_PROXY_DESCRIPTION),
  router: RouterConfigSchema.prefault({}).describe('Routing and model-catalog reconciliation settings.'),
  providers: z.record(z.string().min(1), ProviderAuthoringInputValueSchema),
});

const ConfigEnvelopeSchema = z.object({
  server: ServerConfigSchema.prefault({}).describe('Local server settings.'),
  plugins: PluginsInputSchema,
  proxy: HttpProxyUrlSchema.optional().describe(CONFIG_PROXY_DESCRIPTION),
  router: RouterConfigSchema.prefault({}).describe('Routing and model-catalog reconciliation settings.'),
  providers: z.record(z.string().min(1), z.unknown()),
});

function isLegacyOAuthEntry(value: unknown): boolean {
  return isPlainObject(value) && value['kind'] === ProviderKind.OAuth && Object.hasOwn(value, 'vendor');
}

function inferProviderKind(value: unknown): ProviderKind | undefined {
  if (!isPlainObject(value)) return undefined;
  const kind = value['kind'];
  return Object.values(ProviderKind).includes(kind as ProviderKind) ? (kind as ProviderKind) : undefined;
}

function safeIssuePath(path: readonly PropertyKey[]): readonly (string | number)[] {
  return path.filter(
    (segment): segment is string | number => typeof segment === 'string' || typeof segment === 'number',
  );
}

export const ConfigSchema = ConfigEnvelopeSchema.transform((input) => {
  const providers: Provider[] = [];
  const invalidProviders: InvalidProviderConfig[] = [];
  for (const [id, raw] of Object.entries(input.providers)) {
    if (isLegacyOAuthEntry(raw)) {
      invalidProviders.push({
        id,
        kind: ProviderKind.OAuth,
        code: 'LEGACY_OAUTH_CONFIG_UNSUPPORTED',
        issuePaths: [['vendor']],
      });
      continue;
    }
    const result = ProviderInputValueSchema.safeParse(raw);
    if (!result.success) {
      const kind = inferProviderKind(raw);
      invalidProviders.push({
        id,
        ...(kind === undefined ? {} : { kind }),
        code: 'PROVIDER_CONFIG_INVALID',
        issuePaths: result.error.issues.map((issue) => safeIssuePath(issue.path)),
      });
      continue;
    }
    providers.push(ProviderSchema.parse({ ...result.data, id }));
  }
  providers.sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0));
  return {
    server: input.server,
    plugins: input.plugins,
    proxy: input.proxy,
    router: input.router,
    providers,
    invalidProviders,
  };
});

export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type ConfigInput = z.input<typeof ConfigAuthoringSchema>;
export type Config = z.output<typeof ConfigSchema>;
