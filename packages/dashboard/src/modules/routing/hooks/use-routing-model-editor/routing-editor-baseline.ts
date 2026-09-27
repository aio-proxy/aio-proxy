import type { DashboardRoutingModel } from '@aio-proxy/types';

import { routingMetadataFormValues, type RoutingMetadataFormValues } from '../../lib/routing-metadata-draft';
import { routingFormValues, type RoutingFormValues } from '../use-routing-form';

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
