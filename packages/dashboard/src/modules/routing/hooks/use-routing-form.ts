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

/**
 * Rebase a topology draft onto a freshly fetched model, field by field.
 *
 * Three-way against `base`, the values the draft was made from. A field the user left alone takes
 * the server's value, so a change another operator made to a Provider this draft never touched
 * survives; a field the user did change keeps their value, which is the whole point of Reload after
 * a stale save. Replaying whole rows instead silently reverted every concurrent change, including on
 * Providers the user had no opinion about, and the next save committed that as intent.
 *
 * A field both sides changed resolves to the user's value: they are looking at their own draft and
 * about to save it, and the revision check fires again if the server moves once more.
 */
export const reconcileRoutingFormRows = (
  rows: readonly RoutingFormProviderRow[],
  model: DashboardRoutingModel,
  base: readonly RoutingFormProviderRow[] = [],
): RoutingFormProviderRow[] => {
  const drafts = new Map(rows.map((row) => [row.providerId, row]));
  const bases = new Map(base.map((row) => [row.providerId, row]));
  return model.providers.map((provider) => {
    const draft = drafts.get(provider.id);
    const fresh = overrideDraft(provider);
    if (draft === undefined) return { providerId: provider.id, ...fresh };
    const previous = bases.get(provider.id);
    const priority = draft.priority === previous?.priority ? fresh.priority : draft.priority;
    const weight = draft.weight === previous?.weight ? fresh.weight : draft.weight;
    return {
      providerId: provider.id,
      ...(priority === undefined ? {} : { priority }),
      ...(weight === undefined ? {} : { weight }),
    };
  });
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

export const useRoutingForm = (
  model: DashboardRoutingModel | null,
  onSubmit: (value: RoutingFormValues, form: { reset: (values?: RoutingFormValues) => void }) => void,
  defaultValues?: RoutingFormValues,
) =>
  useForm({
    defaultValues:
      defaultValues ?? ((model === null ? { providers: [] } : routingFormValues(model)) satisfies RoutingFormValues),
    validators: {
      onSubmit: ({ value }) => (RoutingFormValuesSchema.safeParse(value).success ? undefined : 'INVALID_ROUTING'),
    },
    onSubmit: ({ value, formApi }) => onSubmit(value, formApi),
  });
