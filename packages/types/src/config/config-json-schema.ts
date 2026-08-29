import { z } from 'zod';

import { modelsDevRefJsonSchemaOverride } from '../model-metadata/index';
import { ConfigAuthoringSchema } from './config';

export { modelsDevRefJsonSchemaOverride as configSchemaOverride } from '../model-metadata/index';

export function buildConfigJsonSchema(): unknown {
  return z.toJSONSchema(ConfigAuthoringSchema, { io: 'input', override: modelsDevRefJsonSchemaOverride });
}
