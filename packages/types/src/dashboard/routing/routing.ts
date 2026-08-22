import { z } from 'zod';

import { IdSchema } from '../../common';
import { ProviderStateSchema } from '../../plugin';
import { ProviderKind, RoutingPrioritySchema, RoutingWeightSchema } from '../../provider';

export const DashboardRoutingNumberSchema = z.strictObject({
  authored: z.number().optional(),
  effective: z.number(),
  wasNormalized: z.boolean(),
});

const DashboardRoutingProviderOverrideViewSchema = z.strictObject({
  priority: DashboardRoutingNumberSchema.optional(),
  weight: DashboardRoutingNumberSchema.optional(),
});

export const DashboardRoutingProviderSchema = z.strictObject({
  id: IdSchema,
  name: z.string().optional(),
  kind: z.enum(ProviderKind),
  enabled: z.boolean(),
  state: ProviderStateSchema,
  defaults: z.strictObject({
    priority: DashboardRoutingNumberSchema,
    weight: DashboardRoutingNumberSchema,
  }),
  override: DashboardRoutingProviderOverrideViewSchema.optional(),
  effective: z.strictObject({
    priority: z.number(),
    weight: z.number(),
    prioritySource: z.enum(['provider', 'model']),
    weightSource: z.enum(['provider', 'model']),
    eligible: z.boolean(),
    share: z.number().nullable(),
  }),
});

export const DashboardRoutingModelSchema = z.strictObject({
  modelId: IdSchema,
  revision: z.string().min(1),
  baselineProviderIds: z.array(IdSchema).readonly(),
  providerCount: z.number().int().nonnegative(),
  eligibleProviderCount: z.number().int().nonnegative(),
  hasOverrides: z.boolean(),
  tiers: z
    .array(
      z.strictObject({
        priority: z.number(),
        providers: z
          .array(
            z.strictObject({
              providerId: IdSchema,
              weight: z.number(),
              share: z.number(),
            }),
          )
          .readonly(),
      }),
    )
    .readonly(),
  providers: z.array(DashboardRoutingProviderSchema).readonly(),
});

export const DashboardRoutingModelsResponseSchema = z.strictObject({
  writable: z.boolean(),
  models: z.array(DashboardRoutingModelSchema).readonly(),
});

const DashboardRoutingProviderOverrideSchema = z
  .strictObject({
    priority: RoutingPrioritySchema.optional(),
    weight: RoutingWeightSchema.optional(),
  })
  .refine((value) => value.priority !== undefined || value.weight !== undefined, {
    message: 'Override must include priority or weight',
  });

function refineUniqueBaselineProviderIds(ids: readonly string[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate provider id ${id}`,
        path: [index],
      });
    }
    seen.add(id);
  }
}

export const DashboardRoutingModelMutationSchema = z.strictObject({
  modelId: IdSchema,
  revision: z.string().min(1),
  baselineProviderIds: z.array(IdSchema).superRefine(refineUniqueBaselineProviderIds).readonly(),
  providers: z.record(IdSchema, DashboardRoutingProviderOverrideSchema),
});

export const DashboardRoutingMutationErrorCodeSchema = z.enum([
  'config_unavailable',
  'stale_revision',
  'validation_failed',
]);

export type DashboardRoutingNumber = z.output<typeof DashboardRoutingNumberSchema>;
export type DashboardRoutingProvider = z.output<typeof DashboardRoutingProviderSchema>;
export type DashboardRoutingModel = z.output<typeof DashboardRoutingModelSchema>;
export type DashboardRoutingModelsResponse = z.output<typeof DashboardRoutingModelsResponseSchema>;
export type DashboardRoutingModelMutation = z.output<typeof DashboardRoutingModelMutationSchema>;
export type DashboardRoutingMutationErrorCode = z.output<typeof DashboardRoutingMutationErrorCodeSchema>;
