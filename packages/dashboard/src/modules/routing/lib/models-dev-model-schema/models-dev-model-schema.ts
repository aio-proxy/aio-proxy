import { MODELS_DEV_SCHEMA_ID } from '@aio-proxy/types';

/** JSON Schema document that `$ref`s `MODELS_DEV_MODEL_REF` resolve against. */
export const createModelsDevModelSchemaDocument = (slugs: readonly string[] | undefined) => ({
  $id: MODELS_DEV_SCHEMA_ID,
  $defs: {
    Model:
      slugs === undefined || slugs.length === 0
        ? { type: 'string' as const, minLength: 1 }
        : { type: 'string' as const, enum: [...slugs] },
  },
});
