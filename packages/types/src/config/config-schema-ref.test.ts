import { expect, test } from 'bun:test';

import { z } from 'zod';

import { ConfigAuthoringSchema, MODELS_DEV_MODEL_REF, configSchemaOverride } from '../index';

test('extend renders as an external $ref to the models.dev Model schema under router.models metadata', () => {
  const json = z.toJSONSchema(ConfigAuthoringSchema, { io: 'input', override: configSchemaOverride }) as {
    $defs?: Record<string, unknown>;
    properties?: {
      router?: {
        properties?: {
          models?: {
            additionalProperties?: {
              properties?: { metadata?: { properties?: { extend?: { $ref?: string } } } };
            };
          };
        };
      };
    };
  };
  const schema = JSON.stringify(json);
  const extendRef =
    json.properties?.router?.properties?.models?.additionalProperties?.properties?.metadata?.properties?.extend?.$ref;
  // The emitted schema must reference the external models.dev slug enum for extend,
  // and must NOT inline the multi-thousand-entry enum.
  expect(extendRef).toBe(MODELS_DEV_MODEL_REF);
  expect(schema).toContain(MODELS_DEV_MODEL_REF);
  expect(schema).not.toContain('302ai/'); // no inlined slug enum
  // Clean inline $ref (no $defs double-hop): no local ref to a hoisted models.dev def.
  expect(schema).not.toContain('#/$defs/ModelsDevModelRef');
  expect(json.$defs?.ModelsDevModelRef).toBeUndefined();
});
