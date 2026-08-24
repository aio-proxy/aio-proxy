import { z } from 'zod';

import { IdSchema } from '../../common';
import type { RouterProviderOverride } from '../../config';
import { type ProviderState, ProviderStateSchema } from '../../plugin';
import { ProviderKind, RoutingPrioritySchema, RoutingWeightSchema } from '../../provider';

const matchesDto =
  <Dto>() =>
  <Schema extends z.ZodType<Dto>>(schema: Schema): Schema =>
    schema;

export type DashboardRoutingNumber = {
  readonly authored?: number;
  readonly effective: number;
  readonly wasNormalized: boolean;
};

export type DashboardRoutingProvider = {
  readonly id: string;
  readonly name?: string;
  readonly kind: ProviderKind;
  readonly enabled: boolean;
  readonly state: ProviderState;
  readonly defaults: { readonly priority: DashboardRoutingNumber; readonly weight: DashboardRoutingNumber };
  readonly override?: {
    readonly priority?: DashboardRoutingNumber;
    readonly weight?: DashboardRoutingNumber;
  };
  readonly effective: {
    readonly priority: number;
    readonly weight: number;
    readonly prioritySource: 'provider' | 'model';
    readonly weightSource: 'provider' | 'model';
    readonly eligible: boolean;
    readonly share: number | null;
  };
};

export type DashboardRoutingModel = {
  readonly modelId: string;
  readonly revision: string;
  readonly baselineProviderIds: readonly string[];
  readonly providerCount: number;
  readonly eligibleProviderCount: number;
  readonly hasOverrides: boolean;
  readonly tiers: readonly {
    readonly priority: number;
    readonly providers: readonly { readonly providerId: string; readonly weight: number; readonly share: number }[];
  }[];
  readonly providers: readonly DashboardRoutingProvider[];
};

export type DashboardRoutingModelsResponse = {
  readonly writable: boolean;
  readonly models: readonly DashboardRoutingModel[];
};

export type DashboardRoutingModelMutation = {
  readonly modelId: string;
  readonly revision: string;
  readonly baselineProviderIds: readonly string[];
  readonly providers: Readonly<Record<string, RouterProviderOverride>>;
};

export const DashboardRoutingNumberSchema = matchesDto<DashboardRoutingNumber>()(
  z.strictObject({
    authored: z.number().optional(),
    effective: z.number(),
    wasNormalized: z.boolean(),
  }),
);

const DashboardRoutingProviderOverrideViewSchema = z.strictObject({
  priority: DashboardRoutingNumberSchema.optional(),
  weight: DashboardRoutingNumberSchema.optional(),
});

export const DashboardRoutingProviderSchema = matchesDto<DashboardRoutingProvider>()(
  z.strictObject({
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
  }),
);

export const DashboardRoutingModelSchema = matchesDto<DashboardRoutingModel>()(
  z.strictObject({
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
  }),
);

export const DashboardRoutingModelsResponseSchema = matchesDto<DashboardRoutingModelsResponse>()(
  z.strictObject({
    writable: z.boolean(),
    models: z.array(DashboardRoutingModelSchema).readonly(),
  }),
);

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

export const DashboardRoutingModelMutationSchema = matchesDto<DashboardRoutingModelMutation>()(
  z.strictObject({
    modelId: IdSchema,
    revision: z.string().min(1),
    baselineProviderIds: z.array(IdSchema).superRefine(refineUniqueBaselineProviderIds).readonly(),
    providers: z.record(IdSchema, DashboardRoutingProviderOverrideSchema),
  }),
);

export const DashboardRoutingMutationErrorCodeSchema = z.enum([
  'config_unavailable',
  'stale_revision',
  'validation_failed',
]);

export type DashboardRoutingMutationErrorCode = z.output<typeof DashboardRoutingMutationErrorCodeSchema>;
