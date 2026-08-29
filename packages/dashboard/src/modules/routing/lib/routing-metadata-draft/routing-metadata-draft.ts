import {
  ModelCostSchema,
  ModelLimitSchema,
  type DashboardRoutingModel,
  type DashboardRoutingModelMutation,
  type ModelCostInput,
  type ModelLimitInput,
  type ModelMetadataInput,
  type RouterProviderOverride,
} from '@aio-proxy/types';
import type { ZodType } from 'zod';

/**
 * Tri-state draft for the mutation contract: an untouched draft is OMITTED from the PUT body
 * (the server preserves the stored value), a touched-and-emptied draft sends `null` (clear),
 * and a touched draft with keys sends the object (replace).
 */
export type RoutingMetadataDraft<T extends object> = {
  readonly touched: boolean;
  readonly value: T | undefined;
};

export type RoutingProviderOverrideDraft = {
  readonly cost: RoutingMetadataDraft<ModelCostInput>;
  readonly limit: RoutingMetadataDraft<ModelLimitInput>;
};

export type RoutingMetadataFormValues = {
  readonly metadata: RoutingMetadataDraft<ModelMetadataInput>;
  readonly overrides: Readonly<Record<string, RoutingProviderOverrideDraft>>;
};

const seeded = <T extends object>(value: T | undefined): RoutingMetadataDraft<T> => ({ touched: false, value });

export const emptyRoutingMetadataFormValues = (): RoutingMetadataFormValues => ({
  metadata: seeded<ModelMetadataInput>(undefined),
  overrides: {},
});

export const routingMetadataFormValues = (model: DashboardRoutingModel): RoutingMetadataFormValues => ({
  metadata: seeded(model.metadata),
  overrides: Object.fromEntries(
    model.providers.map((provider) => [
      provider.id,
      { cost: seeded(provider.override?.cost), limit: seeded(provider.override?.limit) },
    ]),
  ),
});

/** After a stale-revision reload: untouched drafts re-seed from the fresh model; edits are kept. */
export const reconcileRoutingMetadataValues = (
  values: RoutingMetadataFormValues,
  model: DashboardRoutingModel,
): RoutingMetadataFormValues => {
  const fresh = routingMetadataFormValues(model);
  return {
    metadata: values.metadata.touched ? values.metadata : fresh.metadata,
    overrides: Object.fromEntries(
      Object.entries(fresh.overrides).map(([providerId, freshDraft]) => {
        const current = values.overrides[providerId];
        return [
          providerId,
          {
            cost: current?.cost.touched ? current.cost : freshDraft.cost,
            limit: current?.limit.touched ? current.limit : freshDraft.limit,
          },
        ];
      }),
    ),
  };
};

type MutationProviderOverride = DashboardRoutingModelMutation['providers'][string];

const touchedGroupValid = (draft: RoutingMetadataDraft<object> | undefined, schema: ZodType): boolean => {
  if (draft === undefined || !draft.touched) return true;
  if (draft.value === undefined || Object.keys(draft.value).length === 0) return true;
  return schema.safeParse(draft.value).success;
};

/** Whether every touched cost/limit draft would pass the same Zod the PUT body uses. */
export const routingOverrideDraftsValid = (overrides: RoutingMetadataFormValues['overrides']): boolean =>
  Object.values(overrides).every(
    (draft) => touchedGroupValid(draft.cost, ModelCostSchema) && touchedGroupValid(draft.limit, ModelLimitSchema),
  );

const patchOf = <T extends object>(draft: RoutingMetadataDraft<T> | undefined): T | null | undefined => {
  if (draft === undefined || !draft.touched) return undefined;
  // A draft whose every field was cleared means "remove the stored override", not "store {}".
  return draft.value === undefined || Object.keys(draft.value).length === 0 ? null : draft.value;
};

/**
 * The PUT body merge: the board rows carry ONLY priority/weight (by design — see routing-board),
 * so provider entries gain cost/limit keys exclusively from the drawer's touched drafts. A
 * board-only save therefore produces entries with no cost/limit keys at all, which is what keeps
 * drag/share/reset flows from deleting stored metadata server-side.
 */
export const mergeRoutingMutationDrafts = (
  routing: Readonly<Record<string, RouterProviderOverride>>,
  values: RoutingMetadataFormValues,
): Pick<DashboardRoutingModelMutation, 'metadata' | 'providers'> => {
  const providers: Record<string, MutationProviderOverride> = {};
  const providerIds = new Set([...Object.keys(routing), ...Object.keys(values.overrides)]);
  for (const providerId of providerIds) {
    const cost = patchOf(values.overrides[providerId]?.cost);
    const limit = patchOf(values.overrides[providerId]?.limit);
    const base = routing[providerId];
    providers[providerId] = {
      ...base,
      ...(cost === undefined ? {} : { cost }),
      ...(limit === undefined ? {} : { limit }),
    };
  }
  const metadata = patchOf(values.metadata);
  return { ...(metadata === undefined ? {} : { metadata }), providers };
};
