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
    id: z.string(),
    type: z.literal('message'),
    role: z.literal('assistant'),
    content: z.array(contentBlockSchema),
    model: z.string(),
    stop_reason: z.string().nullable(),
    usage: usageSchema,
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
  .object({ type: z.string().min(1) })
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
