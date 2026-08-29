import type { DashboardRoutingModel } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';

import {
  emptyRoutingMetadataFormValues,
  routingMetadataFormValues,
  type RoutingMetadataFormValues,
} from '../lib/routing-metadata-draft';

/**
 * Drawer-local drafts for the model's `metadata` and the per-provider cost/limit overrides —
 * deliberately separate from `useRoutingForm`, whose rows stay priority/weight-only so board
 * moves can never carry (or drop) metadata. No submit handler: the routing form's submit reads
 * these values and merges them into the one PUT body.
 */
export const useRoutingMetadataForm = (model: DashboardRoutingModel | null) =>
  useForm({
    defaultValues: (model === null
      ? emptyRoutingMetadataFormValues()
      : routingMetadataFormValues(model)) satisfies RoutingMetadataFormValues,
  });
