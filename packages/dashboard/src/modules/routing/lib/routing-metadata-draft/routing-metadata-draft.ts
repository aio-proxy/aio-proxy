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
import { isEqual, isPlainObject } from 'es-toolkit/predicate';
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

/**
 * Three-way merge of one draft value against the baseline it was edited from. A key the user left at
 * its baseline value takes the server's fresh one, so another operator's change survives a reload; a
 * key the user changed keeps the user's value, which is what the next save is meant to write. Arrays
 * (price tiers) are single values, since the config replaces them wholesale.
 */
const mergeDraftValue = (base: unknown, draft: unknown, fresh: unknown): unknown => {
  if (isEqual(draft, base)) return fresh;
  if (isEqual(fresh, base)) return draft;
  if (!isPlainObject(base) || !isPlainObject(draft) || !isPlainObject(fresh)) return draft;
  const merged: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(draft), ...Object.keys(fresh)])) {
    const value = mergeDraftValue(base[key], draft[key], fresh[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};

const mergeDraft = <T extends object>(
  draft: RoutingMetadataDraft<T> | undefined,
  base: RoutingMetadataDraft<T> | undefined,
  fresh: RoutingMetadataDraft<T>,
): RoutingMetadataDraft<T> =>
  draft?.touched
    ? { touched: true, value: mergeDraftValue(base?.value, draft.value, fresh.value) as T | undefined }
    : fresh;

/**
 * After a stale-revision reload: untouched drafts re-seed from the fresh model, and touched ones are
 * merged field by field against `base`, the values the drafts were edited from. Replaying a touched
 * group whole would write the stale copy of every field in it back over the server's newer values.
 */
export const reconcileRoutingMetadataValues = (
  values: RoutingMetadataFormValues,
  model: DashboardRoutingModel,
  base: RoutingMetadataFormValues,
): RoutingMetadataFormValues => {
  const fresh = routingMetadataFormValues(model);
  return {
    metadata: mergeDraft(values.metadata, base.metadata, fresh.metadata),
    overrides: Object.fromEntries(
      Object.entries(fresh.overrides).map(([providerId, freshDraft]) => {
        const current = values.overrides[providerId];
        const previous = base.overrides[providerId];
        return [
          providerId,
          {
            cost: mergeDraft(current?.cost, previous?.cost, freshDraft.cost),
            limit: mergeDraft(current?.limit, previous?.limit, freshDraft.limit),
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

/** Which editor tab holds unsaved work. Drives both the per-tab markers and the navigation guard. */
export type RoutingDirtyTab = 'topology' | 'metadata' | 'cost';

/** True when any cost or limit override group has been touched. */
export const routingOverrideDraftsTouched = (overrides: RoutingMetadataFormValues['overrides']): boolean =>
  Object.values(overrides).some((override) => override.cost.touched || override.limit.touched);

/** True when either half of the metadata form holds unsaved work. */
export const routingMetadataTouched = (values: RoutingMetadataFormValues): boolean =>
  values.metadata.touched || routingOverrideDraftsTouched(values.overrides);

export const routingDirtyTabs = (
  topologyDirty: boolean,
  metadata: RoutingMetadataFormValues,
): readonly RoutingDirtyTab[] => [
  ...(topologyDirty ? (['topology'] as const) : []),
  ...(metadata.metadata.touched ? (['metadata'] as const) : []),
  ...(routingOverrideDraftsTouched(metadata.overrides) ? (['cost'] as const) : []),
];

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
