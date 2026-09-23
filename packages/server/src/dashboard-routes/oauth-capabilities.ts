import type { PluginRegistry } from '@aio-proxy/core';
import type { FormField, JsonValue } from '@aio-proxy/plugin-sdk';
import {
  type DashboardOAuthCapability,
  DashboardOAuthCapabilitySchema,
  type DashboardOAuthFormField,
  DashboardOAuthFormFieldSchema,
} from '@aio-proxy/types';

const fieldDefault = (field: FormField): JsonValue | undefined =>
  'defaultValue' in field && field.defaultValue !== undefined ? field.defaultValue : undefined;

export const dashboardOAuthForm = (
  form: readonly FormField[],
  configuredSecrets: ReadonlySet<string> = new Set(),
): readonly DashboardOAuthFormField[] =>
  form.map((field) =>
    DashboardOAuthFormFieldSchema.parse(
      field.type === 'secret' ? { ...field, configured: configuredSecrets.has(field.key) } : field,
    ),
  );

export const dashboardOAuthCapabilities = (registry: PluginRegistry): readonly DashboardOAuthCapability[] =>
  registry.oauthCapabilities().map(({ plugin, capability, adapter }) =>
    DashboardOAuthCapabilitySchema.parse({
      plugin,
      capability,
      displayName: adapter.displayName,
      ...(adapter.description === undefined ? {} : { description: adapter.description }),
      form: dashboardOAuthForm(adapter.account.options.form),
      defaults: Object.fromEntries(
        adapter.account.options.form.flatMap((field) => {
          const value = fieldDefault(field);
          return value === undefined ? [] : [[field.key, value] as const];
        }),
      ),
    }),
  );
