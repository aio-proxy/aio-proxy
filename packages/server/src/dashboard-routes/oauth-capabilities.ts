import type { PluginRegistry } from "@aio-proxy/core";
import type { FormField, JsonValue } from "@aio-proxy/plugin-sdk";

import { type DashboardOAuthCapability, DashboardOAuthCapabilitySchema } from "@aio-proxy/types";

const fieldDefault = (field: FormField): JsonValue | undefined => {
  if (field.type === "boolean" || field.type === "json") return field.defaultValue;
  return undefined;
};

export const dashboardOAuthForm = (form: readonly FormField[], configuredSecrets: ReadonlySet<string> = new Set()) =>
  form.map((field) => (field.type === "secret" ? { ...field, configured: configuredSecrets.has(field.key) } : field));

export const dashboardOAuthCapabilities = (registry: PluginRegistry): readonly DashboardOAuthCapability[] =>
  registry.oauthCapabilities().map(({ plugin, capability, adapter }) =>
    DashboardOAuthCapabilitySchema.parse({
      plugin,
      capability,
      label: adapter.label,
      ...(adapter.description === undefined ? {} : { description: adapter.description }),
      ...(adapter.icon === undefined ? {} : { icon: adapter.icon }),
      form: dashboardOAuthForm(adapter.account.options.form),
      defaults: Object.fromEntries(
        adapter.account.options.form.flatMap((field) => {
          const value = fieldDefault(field);
          return value === undefined ? [] : [[field.key, value] as const];
        }),
      ),
    }),
  );
