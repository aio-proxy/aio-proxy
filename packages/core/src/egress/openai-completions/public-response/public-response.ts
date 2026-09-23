import { z } from 'zod';

const usageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  })
  .loose();

const toolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }).loose(),
  })
  .loose();

export const OpenAICompletionsResponseSchema = z
  .object({
    // Raw matching-protocol responses are forwarded even when these usual envelope fields are absent.
    id: z.string().optional(),
    object: z.literal('chat.completion').optional(),
    created: z.number().int().optional(),
    model: z.string().optional(),
    // Same-protocol failover can forward a JSON object that has no choices array.
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().optional(),
            index: z.number().int().optional(),
            logprobs: z.unknown().nullable().optional(),
            message: z
              .object({
                role: z.literal('assistant'),
                content: z.string().nullable(),
                refusal: z.string().nullable().optional(),
                tool_calls: z.array(toolCallSchema).optional(),
              })
              .loose(),
          })
          .loose(),
      )
      .optional(),
    usage: usageSchema.optional(),
  })
  .loose()
  .meta({
    examples: [
      {
        id: 'chatcmpl-example',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-5',
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            logprobs: null,
            message: { role: 'assistant', content: 'Hello.', refusal: null },
          },
        ],
      },
    ],
  });

export const OpenAICompletionsStreamEventSchema = z
  .object({
    id: z.string(),
    object: z.literal('chat.completion.chunk').optional(),
    created: z.number().int().optional(),
    model: z.string().optional(),
    choices: z.array(
      z
        .object({
          delta: z.object({}).loose(),
          index: z.number().int(),
          // Intermediate raw chunks include delta and index and omit finish_reason until the terminal choice.
          finish_reason: z.string().nullable().optional(),
        })
        .loose(),
    ),
    usage: usageSchema.optional(),
  })
  .loose()
  .meta({
    examples: [
      {
        id: 'chatcmpl-example',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'gpt-5',
        choices: [{ delta: { content: 'Hello' }, index: 0, finish_reason: null }],
      },
    ],
  });

export function formatOpenAICompletionsSSE(events: readonly unknown[]): string {
  return `${events
    .map((event) => `data: ${JSON.stringify(OpenAICompletionsStreamEventSchema.parse(event))}\n\n`)
    .join('')}data: [DONE]\n\n`;
}
