import { z } from 'zod';

const usageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  })
  .loose();

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

export const OpenAICompletionsResponseSchema = z
  .object({
    id: z.string(),
    object: z.literal('chat.completion'),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(
      z.object({
        finish_reason: z.string(),
        index: z.number().int(),
        logprobs: z.unknown().nullable(),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().nullable(),
          refusal: z.string().nullable(),
          tool_calls: z.array(toolCallSchema).optional(),
        }),
      }),
    ),
    usage: usageSchema.optional(),
  })
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
    object: z.literal('chat.completion.chunk'),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(
      z.object({
        delta: z.object({}).loose(),
        index: z.number().int(),
        finish_reason: z.string().nullable(),
      }),
    ),
    usage: usageSchema.optional(),
  })
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
