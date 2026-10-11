import type { PluginRegistry } from '@aio-proxy/core';
import type { FormField, JsonValue, OAuthAdapter } from '@aio-proxy/plugin-sdk';
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

async function detectLocalSignIn(localSignIn: OAuthAdapter['localSignIn']): Promise<boolean> {
  if (localSignIn === undefined) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
      controller.abort();
    }, 2_000);
  });
  try {
    // The race bounds third-party detectors even when they ignore cancellation.
    return await Promise.race([localSignIn.detect({ signal: controller.signal }), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const dashboardOAuthCapabilities = async (
  registry: PluginRegistry,
): Promise<readonly DashboardOAuthCapability[]> =>
  Promise.all(
    registry.oauthCapabilities().map(async ({ plugin, capability, adapter }) => {
      const detected = await detectLocalSignIn(adapter.localSignIn);
      return DashboardOAuthCapabilitySchema.parse({
        plugin,
        capability,
        displayName: adapter.displayName,
        ...(adapter.description === undefined ? {} : { description: adapter.description }),
        ...(detected && adapter.localSignIn !== undefined
          ? { localSignIn: { source: adapter.localSignIn.source } }
          : {}),
        form: dashboardOAuthForm(adapter.account.options.form),
        defaults: Object.fromEntries(
          adapter.account.options.form.flatMap((field) => {
            const value = fieldDefault(field);
            return value === undefined ? [] : [[field.key, value] as const];
          }),
        ),
      });
    }),
  );
