import { z } from 'zod';

const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .loose();

const contentBlockSchema = z
  .object({
    // Raw Anthropic responses can include server-tool and future provider block variants.
    type: z.string().min(1),
  })
  .loose();

export const AnthropicMessageResponseSchema = z
  .object({
    id: z.string().optional(),
    type: z.literal('message').optional(),
    role: z.literal('assistant').optional(),
    content: z.array(contentBlockSchema).optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    usage: usageSchema.optional(),
  })
  .loose()
  .meta({
    examples: [
      {
        id: 'msg_example',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello.', citations: null }],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
  });

export const AnthropicMessagesStreamEventSchema = z
  .object({
    // The SSE event: line can carry the name, so a raw payload may omit type.
    type: z.string().min(1).optional(),
  })
  .loose()
  .meta({
    examples: [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'message_stop' },
    ],
  });

export function formatAnthropicMessagesSSE(events: readonly unknown[]): string {
  return events
    .map((event) => {
      const payload = AnthropicMessagesStreamEventSchema.parse(event);
      return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
    })
    .join('');
}
