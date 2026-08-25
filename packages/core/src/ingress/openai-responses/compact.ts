import { z } from 'zod';

import { OpenAIResponsesTransformError } from '../../error';

const OpenAIResponsesCompactRequestSchema = z
  .object({
    model: z.union([z.string(), z.null()]).optional(),
    input: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
    instructions: z.string().nullable().optional(),
    previous_response_id: z.string().nullable().optional(),
    prompt_cache_key: z.string().nullable().optional(),
    prompt_cache_options: z.unknown().nullable().optional(),
    prompt_cache_retention: z.string().nullable().optional(),
    service_tier: z.string().nullable().optional(),
    stream: z.boolean().nullable().optional(),
  })
  .passthrough();

export type OpenAIResponsesCompactRequest = Omit<z.output<typeof OpenAIResponsesCompactRequestSchema>, 'model'> & {
  model: string;
};

export function parseOpenAIResponsesCompact(input: unknown): OpenAIResponsesCompactRequest {
  const parsed = OpenAIResponsesCompactRequestSchema.parse(input);
  if (parsed.stream === true) {
    throw new OpenAIResponsesTransformError('stream');
  }
  const { model } = parsed;
  if (typeof model !== 'string' || model === '') {
    throw new OpenAIResponsesTransformError('model');
  }
  return { ...parsed, model };
}
