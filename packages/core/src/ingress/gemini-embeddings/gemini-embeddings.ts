import { z } from 'zod';

const textPartSchema = z.object({ text: z.string() }).strict();

const contentSchema = z
  .object({
    parts: z.array(textPartSchema).min(1),
  })
  .superRefine((content, ctx) => {
    const joined = content.parts.map((part) => part.text).join('');
    if (joined === '') {
      ctx.addIssue({
        code: 'custom',
        message: 'Joined text must be non-empty',
      });
    }
  });

const embedContentConfigSchema = z
  .object({
    taskType: z.string().optional(),
    title: z.string().optional(),
    outputDimensionality: z.number().int().optional(),
    autoTruncate: z.boolean().optional(),
    audioTrackExtraction: z.unknown().optional(),
    documentOcr: z.unknown().optional(),
  })
  .superRefine((config, ctx) => {
    if (config.audioTrackExtraction !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'embedContentConfig.audioTrackExtraction is not supported',
      });
    }
    if (config.documentOcr !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'embedContentConfig.documentOcr is not supported',
      });
    }
  })
  .transform(({ audioTrackExtraction: _audioTrackExtraction, documentOcr: _documentOcr, ...rest }) => rest);

export const GeminiEmbedContentRequestSchema = z
  .object({
    model: z.string().optional(),
    content: contentSchema,
    embedContentConfig: embedContentConfigSchema.optional(),
    taskType: z.string().optional(),
    title: z.string().optional(),
    outputDimensionality: z.number().int().optional(),
  })
  .strip();

export const GeminiBatchEmbedContentsRequestSchema = z.object({
  // Official Gemini batchEmbedContents: at most 100 requests in one batch.
  requests: z.array(GeminiEmbedContentRequestSchema).min(1).max(100),
});

export type GeminiEmbedContentRequest = z.output<typeof GeminiEmbedContentRequestSchema>;
export type GeminiBatchEmbedContentsRequest = z.output<typeof GeminiBatchEmbedContentsRequestSchema>;

export function parseGeminiEmbedContent(input: unknown): GeminiEmbedContentRequest {
  return GeminiEmbedContentRequestSchema.parse(input);
}

export function parseGeminiBatchEmbedContents(input: unknown): GeminiBatchEmbedContentsRequest {
  return GeminiBatchEmbedContentsRequestSchema.parse(input);
}
