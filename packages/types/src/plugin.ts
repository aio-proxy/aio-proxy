import { z } from "zod";
import type { ProviderKind } from "./provider";

export const PluginPackageNameSchema = z
  .string()
  .trim()
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u);

export const CapabilityIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

export const DiagnosticCodeSchema = z.enum([
  "PLUGIN_NOT_INSTALLED",
  "PLUGIN_API_INCOMPATIBLE",
  "PLUGIN_LOAD_FAILED",
  "PLUGIN_OPTIONS_INVALID",
  "PROVIDER_CONFIG_INVALID",
  "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
  "CAPABILITY_MISSING",
  "ACCOUNT_OPTIONS_INVALID",
  "CREDENTIALS_MISSING_OR_INVALID",
  "CREDENTIAL_REFRESH_FAILED",
  "AUTHORIZATION_FAILED",
  "CATALOG_UNAVAILABLE",
  "RUNTIME_CREATE_FAILED",
]);

export const DiagnosticSchema = z.object({
  code: DiagnosticCodeSchema,
  summary: z.string().min(1),
  retryable: z.boolean(),
  occurredAt: z.string().datetime(),
  suggestedCommand: z.string().min(1).optional(),
});

export const PluginStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }),
  z.object({ status: z.literal("failed"), diagnostic: DiagnosticSchema }),
]);

export const ProviderStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    catalog: z.enum(["fresh", "stale"]).optional(),
    diagnostic: DiagnosticSchema.optional(),
  }),
  z.object({ status: z.literal("unavailable"), diagnostic: DiagnosticSchema }),
]);

export type DiagnosticCode = z.output<typeof DiagnosticCodeSchema>;
export type Diagnostic = z.output<typeof DiagnosticSchema>;
export type PluginState = z.output<typeof PluginStateSchema>;
export type ProviderState = z.output<typeof ProviderStateSchema>;

export type PluginEnablement = {
  readonly packageName: string;
  readonly options?: unknown;
};

export type InvalidProviderConfig = {
  readonly id: string;
  readonly kind?: ProviderKind;
  readonly code: "PROVIDER_CONFIG_INVALID" | "LEGACY_OAUTH_CONFIG_UNSUPPORTED";
  readonly issuePaths: readonly (readonly (string | number)[])[];
};
