import { z } from "zod";

const idSchema = z.string().min(1);
const inlineDataLimitBytes = 20 * 1024 * 1024;

const looseObjectSchema = z.object({}).catchall(z.unknown());

const inlineDataSchema = z.object({
  mimeType: idSchema,
  data: z.string().min(1),
});

const functionCallSchema = z.object({
  name: idSchema,
  args: z.unknown().optional(),
});

const functionResponseSchema = z.object({
  name: idSchema,
  response: z.unknown(),
});

const partSchema = z
  .object({
    text: z.string().optional(),
    inlineData: inlineDataSchema.optional(),
    functionCall: functionCallSchema.optional(),
    functionResponse: functionResponseSchema.optional(),
  })
  .strict()
  .superRefine((part, ctx) => {
    const count = [
      part.text,
      part.inlineData,
      part.functionCall,
      part.functionResponse,
    ].filter((value) => value !== undefined).length;

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

const generationConfigSchema = looseObjectSchema;

const safetySettingSchema = z
  .object({
    category: idSchema,
    threshold: idSchema,
  })
  .catchall(z.unknown());

export const GeminiGenerateContentRequestSchema = z.object({
  model: idSchema,
  contents: z.array(contentSchema).min(1),
  systemInstruction: systemInstructionSchema.optional(),
  tools: z.array(toolSchema).optional(),
  generationConfig: generationConfigSchema.optional(),
  safetySettings: z.array(safetySettingSchema).optional(),
});

export type GeminiGenerateContentPart = z.infer<typeof partSchema>;
export type GeminiGenerateContentRequest = z.infer<
  typeof GeminiGenerateContentRequestSchema
>;

export class GeminiInlineDataTooLargeError extends Error {
  readonly code = "INLINE_DATA_TOO_LARGE";
  readonly status = 413;

  constructor(
    readonly path: string,
    readonly limitBytes: number,
    readonly actualBytes: number,
  ) {
    super(
      `Gemini inlineData at ${path} is ${actualBytes} bytes; limit is ${limitBytes}`,
    );
    this.name = "GeminiInlineDataTooLargeError";
  }
}

export type GeminiGenerateContentParseResult =
  | {
      readonly ok: true;
      readonly value: GeminiGenerateContentRequest;
    }
  | {
      readonly ok: false;
      readonly error: z.ZodError | GeminiInlineDataTooLargeError;
    };

export function safeParseGeminiGenerateContent(
  input: unknown,
): GeminiGenerateContentParseResult {
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

export function parseGeminiGenerateContent(
  input: unknown,
): GeminiGenerateContentRequest {
  const parsed = GeminiGenerateContentRequestSchema.parse(input);
  const tooLarge = inlineDataTooLarge(parsed);
  if (tooLarge !== undefined) {
    throw tooLarge;
  }

  return parsed;
}

function inlineDataTooLarge(
  request: GeminiGenerateContentRequest,
): GeminiInlineDataTooLargeError | undefined {
  for (const [contentIndex, content] of request.contents.entries()) {
    for (const [partIndex, part] of content.parts.entries()) {
      if (part.inlineData !== undefined) {
        const actualBytes = base64ByteLength(part.inlineData.data);
        if (actualBytes > inlineDataLimitBytes) {
          return new GeminiInlineDataTooLargeError(
            `contents.${contentIndex}.parts.${partIndex}.inlineData.data`,
            inlineDataLimitBytes,
            actualBytes,
          );
        }
      }
    }
  }

  return undefined;
}

function base64ByteLength(data: string): number {
  const padding = (data.endsWith("==") ? 2 : 0) + (data.endsWith("=") ? 1 : 0);
  return Math.floor((data.length * 3) / 4) - padding;
}
