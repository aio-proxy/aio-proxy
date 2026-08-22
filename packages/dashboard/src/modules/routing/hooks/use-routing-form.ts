import type { DashboardRoutingModel } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';

import type { RoutingProviderDraft } from '../lib/routing-summary';

export type RoutingFormValues = {
  providers: Record<string, RoutingProviderDraft>;
};

const RoutingFormValuesSchema = z.object({
  providers: z.record(
    z.string(),
    z.object({
      priority: z.int().optional(),
      weight: z.number().optional(),
    }),
  ),
});

export const routingFormValues = (model: DashboardRoutingModel): RoutingFormValues => ({
  providers: Object.fromEntries(
    model.providers.map((provider) => {
      const priority = provider.override?.priority?.authored ?? provider.override?.priority?.effective;
      const weight = provider.override?.weight?.authored ?? provider.override?.weight?.effective;
      return [
        provider.id,
        {
          ...(priority === undefined ? {} : { priority }),
          ...(weight === undefined ? {} : { weight }),
        },
      ];
    }),
  ),
});

export const useRoutingForm = (model: DashboardRoutingModel | null, onSubmit: (value: RoutingFormValues) => void) =>
  useForm({
    defaultValues: (model === null ? { providers: {} } : routingFormValues(model)) satisfies RoutingFormValues,
    validators: {
      onSubmit: ({ value }) => (RoutingFormValuesSchema.safeParse(value).success ? undefined : 'INVALID_ROUTING'),
    },
    onSubmit: ({ value }) => onSubmit(value),
  });
