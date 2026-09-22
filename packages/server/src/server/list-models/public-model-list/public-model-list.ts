import { z } from 'zod';

const modelSchema = z.object({
  capabilities: z.record(z.string(), z.unknown()).nullable(),
  created: z.number().int(),
  created_at: z.string(),
  display_name: z.string(),
  id: z.string(),
  max_input_tokens: z.number().int().nullable(),
  max_tokens: z.number().int().nullable(),
  object: z.literal('model'),
  owned_by: z.string(),
  type: z.literal('model'),
});

export const PublicModelListSchema = z
  .object({
    data: z.array(modelSchema),
    first_id: z.string().nullable(),
    has_more: z.literal(false),
    last_id: z.string().nullable(),
    object: z.literal('list'),
  })
  .meta({
    examples: [
      {
        data: [
          {
            capabilities: null,
            created: 0,
            created_at: '1970-01-01T00:00:00Z',
            display_name: 'gpt-5',
            id: 'gpt-5',
            max_input_tokens: null,
            max_tokens: null,
            object: 'model',
            owned_by: 'openai',
            type: 'model',
          },
        ],
        first_id: 'gpt-5',
        has_more: false,
        last_id: 'gpt-5',
        object: 'list',
      },
    ],
  });
