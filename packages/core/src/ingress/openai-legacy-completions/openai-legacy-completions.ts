import { z } from 'zod';

const tokenArraySchema = z.array(z.number());
const promptSchema = z.union([z.string(), z.array(z.string()), tokenArraySchema, z.array(tokenArraySchema), z.null()]);

export const OpenAILegacyCompletionsRequestSchema = z.compile(
  z
    .object({
      model: z.string().min(1),
      prompt: promptSchema.optional(),
      suffix: z.string().nullable().optional(),
      max_tokens: z.number().int().nullable().optional(),
      temperature: z.number().nullable().optional(),
      top_p: z.number().nullable().optional(),
      n: z.number().int().nullable().optional(),
      stream: z.boolean().nullable().optional(),
      stream_options: z
        .object({
          include_usage: z.boolean().optional(),
          include_obfuscation: z.boolean().optional(),
        })
        .catchall(z.unknown())
        .nullable()
        .optional(),
      logprobs: z.number().int().nullable().optional(),
      echo: z.boolean().nullable().optional(),
      stop: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
      presence_penalty: z.number().nullable().optional(),
      frequency_penalty: z.number().nullable().optional(),
      best_of: z.number().int().nullable().optional(),
      logit_bias: z.record(z.string(), z.number()).nullable().optional(),
      user: z.string().nullable().optional(),
      seed: z.number().int().nullable().optional(),
      prompt_cache_key: z.string().nullable().optional(),
      metadata: z
        .object({
          session_id: z.string().optional(),
          conversation_id: z.string().optional(),
        })
        .catchall(z.unknown())
        .optional(),
      session_id: z.string().optional(),
      conversation_id: z.string().optional(),
    })
    .loose(),
);

export type OpenAILegacyCompletionsRequest = z.output<typeof OpenAILegacyCompletionsRequestSchema>;

export function parseOpenAILegacyCompletions(input: unknown): OpenAILegacyCompletionsRequest {
  return OpenAILegacyCompletionsRequestSchema.parse(input);
}
