import { z } from "zod";

import { GeminiInlineDataTooLargeError } from "../../error";
import { isHttpUrl, isImageMediaType, isValidBase64 } from "../../image-input";

const idSchema = z.string().min(1);
const inlineDataLimitBytes = 20 * 1024 * 1024;

function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

const inlineDataSchema = z.object({
  mimeType: idSchema,
  data: z.string().min(1).refine(isValidBase64),
});

const fileDataSchema = z.object({
  mimeType: z.string().refine((value) => value !== "image" && isImageMediaType(value)),
  fileUri: z.string().refine(isHttpUrl),
});

const functionResponseInlineDataSchema = inlineDataSchema.extend({
  mimeType: z.string().refine((value) => value !== "image" && isImageMediaType(value)),
});

const functionResponsePartSchema = z
  .object({
    inlineData: functionResponseInlineDataSchema,
  })
  .strict();

const functionCallSchema = z.object({
  id: idSchema.optional(),
  name: idSchema,
  args: z.unknown().optional(),
});

const functionResponseSchema = z.object({
  id: idSchema.optional(),
  name: idSchema,
  response: z.unknown(),
  parts: z.array(functionResponsePartSchema).min(1).optional(),
});

const partSchema = z
  .object({
    text: z.string().optional(),
    inlineData: inlineDataSchema.optional(),
    fileData: fileDataSchema.optional(),
    functionCall: functionCallSchema.optional(),
    functionResponse: functionResponseSchema.optional(),
  })
  .strict()
  .superRefine((part, ctx) => {
    const count = [part.text, part.inlineData, part.fileData, part.functionCall, part.functionResponse].filter(
      (value) => value !== undefined,
    ).length;

    if (count !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Expected exactly one Gemini part variant",
      });
    }
  });

const contentSchema = z.object({
  role: z.enum(["user", "model"]).optional(),
  parts: z.array(partSchema).min(1),
});

const systemInstructionSchema = z.object({
  parts: z
    .array(
      z
        .object({
          text: z.string(),
        })
        .strict(),
    )
    .min(1),
});

const functionDeclarationSchema = z.object({
  name: idSchema,
  description: z.string().optional(),
  parameters: z.unknown().optional(),
});

const toolSchema = z.object({
  functionDeclarations: z.array(functionDeclarationSchema).min(1),
});

const generationConfigSchema = z
  .object({
    thinkingConfig: z
      .object({
        thinkingLevel: idSchema.optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());

const safetySettingSchema = z
  .object({
    category: idSchema,
    threshold: idSchema,
  })
  .catchall(z.unknown());

export const GeminiGenerateContentRequestSchema = z.object({
  model: idSchema,
  contents: z.array(contentSchema).min(1),
  session_id: z.string().optional(),
  conversation_id: z.string().optional(),
  systemInstruction: systemInstructionSchema.optional(),
  tools: z.array(toolSchema).optional(),
  generationConfig: generationConfigSchema.optional(),
  safetySettings: z.array(safetySettingSchema).optional(),
});

export type GeminiGenerateContentPart = z.output<typeof partSchema>;
export type GeminiGenerateContentRequest = z.output<typeof GeminiGenerateContentRequestSchema>;

export type GeminiGenerateContentParseResult =
  | {
      readonly ok: true;
      readonly value: GeminiGenerateContentRequest;
    }
  | {
      readonly ok: false;
      readonly error: z.ZodError | GeminiInlineDataTooLargeError;
    };

export function safeParseGeminiGenerateContent(input: unknown): GeminiGenerateContentParseResult {
  const parsed = GeminiGenerateContentRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error };
  }

  const tooLarge = inlineDataTooLarge(parsed.data);
  if (tooLarge !== undefined) {
    return { ok: false, error: tooLarge };
  }

  return { ok: true, value: parsed.data };
}

export function parseGeminiGenerateContent(input: unknown): GeminiGenerateContentRequest {
  const parsed = GeminiGenerateContentRequestSchema.parse(input);
  const tooLarge = inlineDataTooLarge(parsed);
  if (tooLarge !== undefined) {
    throw tooLarge;
  }

  return parsed;
}

function inlineDataTooLarge(request: GeminiGenerateContentRequest): GeminiInlineDataTooLargeError | undefined {
  for (const [contentIndex, content] of request.contents.entries()) {
    for (const [partIndex, part] of content.parts.entries()) {
      if (part.inlineData !== undefined) {
        const error = oversizedInlineData(
          part.inlineData.data,
          `contents.${contentIndex}.parts.${partIndex}.inlineData.data`,
        );
        if (error !== undefined) return error;
      }
      for (const [responsePartIndex, responsePart] of (part.functionResponse?.parts ?? []).entries()) {
        const error = oversizedInlineData(
          responsePart.inlineData.data,
          `contents.${contentIndex}.parts.${partIndex}.functionResponse.parts.${responsePartIndex}.inlineData.data`,
        );
        if (error !== undefined) return error;
      }
    }
  }

  return undefined;
}

function oversizedInlineData(data: string, path: string): GeminiInlineDataTooLargeError | undefined {
  const actualBytes = base64ByteLength(data);
  return actualBytes > inlineDataLimitBytes
    ? new GeminiInlineDataTooLargeError(path, inlineDataLimitBytes, actualBytes)
    : undefined;
}
