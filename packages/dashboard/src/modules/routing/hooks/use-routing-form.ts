import type { DashboardRoutingModel } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';

import type { RoutingProviderDraft } from '../lib/routing-summary';

export type RoutingFormProviderRow = {
  providerId: string;
  priority?: number;
  weight?: number;
};

export type RoutingFormValues = {
  providers: RoutingFormProviderRow[];
};

export const RoutingPriorityDraftSchema = z.int().optional();
const RoutingWeightDraftSchema = z.number().optional();

const RoutingFormValuesSchema = z.object({
  providers: z.array(
    z.object({
      providerId: z.string().min(1),
      priority: RoutingPriorityDraftSchema,
      weight: RoutingWeightDraftSchema,
    }),
  ),
});

const overrideDraft = (provider: DashboardRoutingModel['providers'][number]): RoutingProviderDraft => {
  const priority = provider.override?.priority?.authored ?? provider.override?.priority?.effective;
  const weight = provider.override?.weight?.authored ?? provider.override?.weight?.effective;
  return {
    ...(priority === undefined ? {} : { priority }),
    ...(weight === undefined ? {} : { weight }),
  };
};

export const routingFormValues = (model: DashboardRoutingModel): RoutingFormValues => ({
  providers: model.providers.map((provider) => ({
    providerId: provider.id,
    ...overrideDraft(provider),
  })),
});

export const reconcileRoutingFormRows = (
  rows: readonly RoutingFormProviderRow[],
  model: DashboardRoutingModel,
): RoutingFormProviderRow[] => {
  const drafts = new Map(rows.map((row) => [row.providerId, row]));
  return model.providers.map(
    (provider) => drafts.get(provider.id) ?? { providerId: provider.id, ...overrideDraft(provider) },
  );
};

export const routingDraftRecord = (rows: readonly RoutingFormProviderRow[]): Record<string, RoutingProviderDraft> =>
  Object.fromEntries(
    rows.map((row) => [
      row.providerId,
      {
        ...(row.priority === undefined ? {} : { priority: row.priority }),
        ...(row.weight === undefined ? {} : { weight: row.weight }),
      },
    ]),
  );

export const useRoutingForm = (model: DashboardRoutingModel | null, onSubmit: (value: RoutingFormValues) => void) =>
  useForm({
    defaultValues: (model === null ? { providers: [] } : routingFormValues(model)) satisfies RoutingFormValues,
    validators: {
      onSubmit: ({ value }) => (RoutingFormValuesSchema.safeParse(value).success ? undefined : 'INVALID_ROUTING'),
    },
    onSubmit: ({ value }) => onSubmit(value),
  });
