import { z } from 'zod';

import { MODELS_DEV_MODEL_REF } from '../model-metadata/index';
import { ConfigAuthoringSchema } from './config';

// The `extend` field is a models.dev slug. Emit an external $ref to models.dev's
// Model slug enum so config editors autocomplete/validate it, instead of inlining
// the ~6000-entry enum. Runtime validation stays a plain non-empty string.
// CONTROLLER-VERIFIED: read the custom meta key via ctx.zodSchema.meta()?.modelsDevRef.
export function configSchemaOverride(ctx: { readonly zodSchema: unknown; jsonSchema: Record<string, unknown> }): void {
  const meta = (ctx.zodSchema as { meta?: () => { modelsDevRef?: boolean } | undefined }).meta?.();
  if (meta?.modelsDevRef === true) {
    for (const key of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[key];
    ctx.jsonSchema['$ref'] = MODELS_DEV_MODEL_REF;
  }
}

export function buildConfigJsonSchema(): unknown {
  return z.toJSONSchema(ConfigAuthoringSchema, { io: 'input', override: configSchemaOverride });
}
