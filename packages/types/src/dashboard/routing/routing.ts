import { z } from 'zod';

import { IdSchema } from '../../common';
import type { RouterProviderOverride } from '../../config';
import {
  type ModelCostInput,
  ModelCostSchema,
  type ModelLimitInput,
  ModelLimitSchema,
  type ModelMetadataInput,
  ModelMetadataSchema,
} from '../../model-metadata';
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

/** models.dev 目录派生的客观事实。与 `metadata`（用户在 config 中授权的覆写）分离：
 * 未授权时 `metadata` 为 undefined，因此不能用它排序或展示厂商归属。
 * `lab` 是模型厂商（openai、anthropic）。models.dev 内部称其为 providerId，
 * 但本仓库 Provider ID 专指上游 provider，两者不可混名。 */
export type DashboardRoutingCatalog = {
  readonly lab: string;
  readonly releaseDate?: string;
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
    readonly cost?: ModelCostInput;
    readonly limit?: ModelLimitInput;
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
  readonly metadata?: ModelMetadataInput;
  readonly catalog?: DashboardRoutingCatalog;
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
  readonly metadata?: ModelMetadataInput | null;
  readonly providers: Readonly<
    Record<
      string,
      Omit<RouterProviderOverride, 'cost' | 'limit'> & {
        readonly cost?: ModelCostInput | null;
        readonly limit?: ModelLimitInput | null;
      }
    >
  >;
};

export const DashboardRoutingNumberSchema = matchesDto<DashboardRoutingNumber>()(
  z.strictObject({
    authored: z.number().optional(),
    effective: z.number(),
    wasNormalized: z.boolean(),
  }),
);

export const DashboardRoutingCatalogSchema = matchesDto<DashboardRoutingCatalog>()(
  z.strictObject({
    lab: z.string().min(1),
    // models.dev 给的是 YYYY-MM 或 YYYY-MM-DD，两种都原样透传：
    // 消费端按字符串比较排序，不解析为 Date，以免引入时区偏移。
    releaseDate: z.string().min(1).optional(),
  }),
);

const DashboardRoutingProviderOverrideViewSchema = z.strictObject({
  priority: DashboardRoutingNumberSchema.optional(),
  weight: DashboardRoutingNumberSchema.optional(),
  cost: ModelCostSchema.optional(),
  limit: ModelLimitSchema.optional(),
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
    metadata: ModelMetadataSchema.optional(),
    catalog: DashboardRoutingCatalogSchema.optional(),
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

// Empty `{}` is a preservation patch: the board/drawer submit every baseline
// Provider, and applyRoutingMutation keeps stored cost/limit when those keys
// are absent. A non-empty refine would 400 those saves.
const DashboardRoutingProviderOverrideSchema = z.strictObject({
  priority: RoutingPrioritySchema.optional(),
  weight: RoutingWeightSchema.optional(),
  cost: ModelCostSchema.nullable().optional(),
  limit: ModelLimitSchema.nullable().optional(),
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
    metadata: ModelMetadataSchema.nullable().optional(),
    providers: z.record(IdSchema, DashboardRoutingProviderOverrideSchema),
  }),
);

export const DashboardRoutingMutationErrorCodeSchema = z.enum([
  'config_unavailable',
  'stale_revision',
  'validation_failed',
]);

export type DashboardRoutingMutationErrorCode = z.output<typeof DashboardRoutingMutationErrorCodeSchema>;
