import { z } from 'zod';

const outputItemSchema = z
  .object({
    id: z.string(),
    // Matching-protocol providers can forward hosted-tool and provider-defined output items unchanged.
    type: z.string().min(1),
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
    id: z.string().optional(),
    object: z.literal('response').optional(),
    created_at: z.number().int().optional(),
    model: z.string().optional(),
    output: z.array(outputItemSchema).optional(),
    output_text: z.string().optional(),
    status: z.enum(['completed', 'failed', 'in_progress', 'incomplete', 'queued', 'cancelled']).optional(),
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
    sequence_number: z.number().int().nonnegative().optional(),
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
      {
        type: 'response.completed',
        sequence_number: 2,
        response: {
          id: 'resp_example',
          object: 'response',
          created_at: 0,
          model: 'gpt-5',
          output: [],
          output_text: 'Hello',
          status: 'completed',
        },
      },
    ],
  });

export function formatOpenAIResponsesSSE(events: readonly unknown[]): string {
  return events
    .map((event) => {
      const payload = OpenAIResponsesStreamEventSchema.parse(event);
      return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
    })
    .join('');
}
