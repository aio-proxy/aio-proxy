import { z } from "zod";

import { AliasConfigSchema, IdSchema } from "./common";
import { DashboardLocalizedTextSchema } from "./dashboard-localized-text";

const DashboardOAuthFormConditionSchema = z.strictObject({
  key: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

const DashboardOAuthFormFieldBaseSchema = z.object({
  key: z.string().min(1),
  label: DashboardLocalizedTextSchema,
  description: DashboardLocalizedTextSchema.optional(),
  when: DashboardOAuthFormConditionSchema.optional(),
});

const dashboardOAuthFormField = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ ...DashboardOAuthFormFieldBaseSchema.shape, ...shape });

export const DashboardOAuthFormFieldSchema = z.discriminatedUnion("type", [
  dashboardOAuthFormField({ type: z.literal("text"), placeholder: DashboardLocalizedTextSchema.optional() }),
  dashboardOAuthFormField({ type: z.literal("secret"), configured: z.boolean().default(false) }),
  dashboardOAuthFormField({ type: z.literal("number"), placeholder: DashboardLocalizedTextSchema.optional() }),
  dashboardOAuthFormField({ type: z.literal("boolean"), defaultValue: z.boolean().optional() }),
  dashboardOAuthFormField({
    type: z.literal("select"),
    options: z.array(
      z.strictObject({
        value: z.union([z.string(), z.number(), z.boolean()]),
        label: DashboardLocalizedTextSchema,
        description: DashboardLocalizedTextSchema.optional(),
      }),
    ),
  }),
  dashboardOAuthFormField({
    type: z.literal("json"),
    placeholder: DashboardLocalizedTextSchema.optional(),
    defaultValue: z.json().optional(),
  }),
]);

export const DashboardOAuthCapabilitySchema = z.strictObject({
  plugin: z.string().min(1),
  capability: z.string().min(1),
  label: DashboardLocalizedTextSchema,
  description: DashboardLocalizedTextSchema.optional(),
  icon: z.string().min(1).optional(),
  form: z.array(DashboardOAuthFormFieldSchema),
  defaults: z.record(z.string(), z.json()),
});

export const DashboardOAuthCapabilitiesResponseSchema = z.strictObject({
  capabilities: z.array(DashboardOAuthCapabilitySchema),
});

export const DashboardOAuthProviderEditSchema = z.strictObject({
  accountLabel: z.string().min(1),
  publicValues: z.record(z.string(), z.json()),
  form: z.array(DashboardOAuthFormFieldSchema),
  models: z.array(z.string()),
});

const DashboardOAuthSessionCommonSchema = z.object({ id: z.uuid() });

export const DashboardOAuthProviderPatchSchema = z.strictObject({
  name: z.string().optional(),
  enabled: z.boolean(),
  weight: z.number().optional(),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional(),
});

export const DashboardOAuthSessionSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...DashboardOAuthSessionCommonSchema.shape, status: z.literal("preparing") }),
  z.strictObject({
    ...DashboardOAuthSessionCommonSchema.shape,
    status: z.literal("device_code"),
    url: z.url(),
    userCode: z.string().min(1),
    instructions: DashboardLocalizedTextSchema.optional(),
  }),
  z.strictObject({
    ...DashboardOAuthSessionCommonSchema.shape,
    status: z.literal("loopback"),
    authorizationUrl: z.url(),
    allowManualCallback: z.boolean(),
  }),
  z.strictObject({ ...DashboardOAuthSessionCommonSchema.shape, status: z.literal("discovering") }),
  z.strictObject({
    ...DashboardOAuthSessionCommonSchema.shape,
    status: z.literal("succeeded"),
    providerId: IdSchema,
    duplicate: z.boolean().optional(),
    warning: z.literal("catalog_unavailable").optional(),
  }),
  z.strictObject({
    ...DashboardOAuthSessionCommonSchema.shape,
    status: z.literal("failed"),
    code: z.string().min(1),
    providerId: IdSchema.optional(),
  }),
  z.strictObject({ ...DashboardOAuthSessionCommonSchema.shape, status: z.literal("cancelled") }),
]);

export const DashboardOAuthSessionStartSchema = z
  .strictObject({
    capability: z.strictObject({ plugin: z.string().min(1), capability: z.string().min(1) }).optional(),
    targetProviderId: IdSchema.optional(),
    publicValues: z.record(z.string(), z.json()).default({}),
    secrets: z.record(z.string(), z.string()).default({}),
    clearSecrets: z.array(z.string().min(1)).default([]),
    providerPatch: DashboardOAuthProviderPatchSchema.optional(),
  })
  .refine((value) => value.capability !== undefined || value.targetProviderId !== undefined, {
    message: "capability or targetProviderId is required",
  });

export const DashboardOAuthSessionResponseSchema = z.strictObject({ session: DashboardOAuthSessionSchema });
export const DashboardOAuthCallbackSubmissionSchema = z.strictObject({ callbackUrl: z.string().min(1) });

export type DashboardOAuthFormField = z.output<typeof DashboardOAuthFormFieldSchema>;
export type DashboardOAuthCapability = z.output<typeof DashboardOAuthCapabilitySchema>;
export type DashboardOAuthCapabilitiesResponse = z.output<typeof DashboardOAuthCapabilitiesResponseSchema>;
export type DashboardOAuthProviderEdit = z.output<typeof DashboardOAuthProviderEditSchema>;
export type DashboardOAuthSession = z.output<typeof DashboardOAuthSessionSchema>;
export type DashboardOAuthSessionStart = z.output<typeof DashboardOAuthSessionStartSchema>;
export type DashboardOAuthProviderPatch = z.output<typeof DashboardOAuthProviderPatchSchema>;
