import { z } from 'zod';

export const DashboardProviderEnabledMutationBodySchema = z.strictObject({
  enabled: z.boolean(),
});

export type DashboardProviderEnabledMutationBodyInput = z.input<typeof DashboardProviderEnabledMutationBodySchema>;
export type DashboardProviderEnabledMutationBody = z.output<typeof DashboardProviderEnabledMutationBodySchema>;
