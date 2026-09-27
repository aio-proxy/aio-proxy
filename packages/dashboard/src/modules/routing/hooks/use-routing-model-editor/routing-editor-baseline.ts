import type { DashboardRoutingModel } from '@aio-proxy/types';

import {
  reconcileRoutingMetadataValues,
  routingMetadataFormValues,
  type RoutingMetadataFormValues,
} from '../../lib/routing-metadata-draft';
import {
  reconcileRoutingFormRows,
  routingFormValues,
  type RoutingFormProviderRow,
  type RoutingFormValues,
} from '../use-routing-form';

/**
 * What the drafts are based on: the values the forms reset to, plus the revision and baseline
 * Provider set the next save is checked against.
 *
 * The revision travels with the default values rather than being read off the rendered model, and
 * that pairing is the point. When the routing query refreshes while a draft is dirty the draft is
 * deliberately kept, so sending the freshly rendered revision would tell the server the stale draft
 * was written against the newest policy — the optimistic-concurrency check would pass and silently
 * overwrite whatever changed underneath it. Submitting the revision the draft was actually based on
 * makes the server reject it as stale, which is the flow Reload exists to resolve.
 */
export type RoutingEditorBaseline = {
  readonly form: RoutingFormValues;
  readonly metadata: RoutingMetadataFormValues;
  readonly revision: string;
  readonly baselineProviderIds: readonly string[];
};

export const routingEditorBaseline = (model: DashboardRoutingModel): RoutingEditorBaseline => ({
  form: routingFormValues(model),
  metadata: routingMetadataFormValues(model),
  revision: model.revision,
  baselineProviderIds: model.baselineProviderIds,
});

export type RoutingEditorRebase = {
  /** What the server holds: the values the forms reset to, and the basis the next save is checked against. */
  readonly baseline: RoutingEditorBaseline;
  /** The drafts to lay back on top of that baseline, so unsaved work keeps reading as unsaved. */
  readonly providers: RoutingFormProviderRow[];
  readonly metadata: RoutingMetadataFormValues;
};

/**
 * Rebase both drafts onto a freshly fetched model.
 *
 * `base` is the baseline the drafts were made from, which makes the topology merge three-way: a
 * field the user left alone takes the server's value rather than replaying a stale one over a change
 * another operator made.
 */
export const routingEditorRebase = (
  model: DashboardRoutingModel,
  draft: {
    readonly providers: readonly RoutingFormProviderRow[];
    readonly metadata: RoutingMetadataFormValues;
  },
  base: readonly RoutingFormProviderRow[],
): RoutingEditorRebase => ({
  baseline: routingEditorBaseline(model),
  providers: reconcileRoutingFormRows(draft.providers, model, base),
  metadata: reconcileRoutingMetadataValues(draft.metadata, model),
});

/**
 * What must match for a rendered model to be the one the drafts are already based on.
 *
 * The revision alone is not enough: it digests `router.models[modelId]` only, so adding or removing
 * a Provider that serves this model leaves it untouched. Gating on the revision by itself left the
 * form holding a row for a Provider the config no longer has, and the next save wrote that row back
 * as an override on it — the server preserves entries outside `baselineProviderIds`, so a stale list
 * also decided the wrong overrides to keep.
 */
export const routingModelIdentity = (model: DashboardRoutingModel) => ({
  modelId: model.modelId,
  revision: model.revision,
  // The list the form's rows mirror, so the effect reconciles exactly when they would go stale.
  providers: model.providers.map((provider) => provider.id).join('\u0000'),
});

export type RoutingModelIdentity = ReturnType<typeof routingModelIdentity>;

export const sameRoutingModelIdentity = (left: RoutingModelIdentity, right: RoutingModelIdentity): boolean =>
  left.modelId === right.modelId && left.revision === right.revision && left.providers === right.providers;
