import { z } from 'zod';

import { ModelIdSchema } from '../common';

export const syncModelsFields = {
  syncModels: z.boolean().optional().describe('Track the upstream model catalog instead of a static models list.'),
  excludedModels: z.array(ModelIdSchema).optional().describe('Discovered model ids hidden from this provider.'),
} as const;

export const syncModelsMutationFields = {
  ...syncModelsFields,
  excludedModels: z.array(z.string()).optional().describe('Discovered model ids hidden from this provider.'),
} as const;

export function validateSyncModels(
  value: { kind: string; syncModels?: boolean; models?: readonly string[]; excludedModels?: readonly string[] },
  ctx: z.RefinementCtx,
): void {
  if (value.kind === 'oauth') return;

  if (value.syncModels === true && (value.models?.length ?? 0) > 0) {
    ctx.addIssue({ code: 'custom', path: ['models'], message: 'models and syncModels are mutually exclusive' });
  }
  if (value.excludedModels !== undefined && value.syncModels !== true) {
    ctx.addIssue({ code: 'custom', path: ['excludedModels'], message: 'excludedModels requires syncModels' });
  }
}
