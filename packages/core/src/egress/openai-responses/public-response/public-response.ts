import { z } from 'zod';

const outputItemSchema = z
  .object({
    id: z.string(),
    type: z.enum(['message', 'reasoning', 'function_call', 'custom_tool_call']),
    status: z.string().optional(),
  })
  .loose();

const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  })
  .loose();

export const OpenAIResponsesResponseSchema = z
  .object({
    id: z.string(),
    object: z.literal('response'),
    created_at: z.number().int(),
    model: z.string(),
    output: z.array(outputItemSchema),
    output_text: z.string(),
    status: z.enum(['completed', 'failed', 'in_progress']),
    usage: usageSchema.optional(),
  })
  .loose()
  .meta({
    examples: [
      {
        id: 'resp_example',
        object: 'response',
        created_at: 0,
        model: 'gpt-5',
        output: [
          {
            id: 'msg_example',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Hello.', annotations: [], logprobs: [] }],
          },
        ],
        output_text: 'Hello.',
        status: 'completed',
      },
    ],
  });

export const OpenAIResponsesStreamEventSchema = z
  .object({
    type: z.string().min(1),
    sequence_number: z.number().int().nonnegative(),
  })
  .loose()
  .meta({
    examples: [
      {
        type: 'response.output_text.delta',
        sequence_number: 1,
        item_id: 'msg_example',
        output_index: 0,
        content_index: 0,
        delta: 'Hello',
        logprobs: [],
      },
    ],
  });
