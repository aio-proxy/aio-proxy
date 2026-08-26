import { z } from 'zod';

const OpenAIEmbeddingsInputSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1).max(2048),
  z.array(z.number()).min(1).max(2048),
  z.array(z.array(z.number()).min(1)).min(1).max(2048),
]);

export const OpenAIEmbeddingsRequestSchema = z.object({
  model: z.string().min(1),
  input: OpenAIEmbeddingsInputSchema,
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
});

export type OpenAIEmbeddingsRequest = z.output<typeof OpenAIEmbeddingsRequestSchema>;

export function parseOpenAIEmbeddings(input: unknown): OpenAIEmbeddingsRequest {
  return OpenAIEmbeddingsRequestSchema.parse(input);
}
