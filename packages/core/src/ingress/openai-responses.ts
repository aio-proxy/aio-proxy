import { z } from "zod";

const idSchema = z.string().min(1);
const looseObjectSchema = z.object({}).catchall(z.unknown());
const forbiddenToolTypes = [
  "computer-use",
  "computer_use",
  "computer_use_preview",
  "file_search",
  "web_search",
  "web_search_preview",
  "image_generation",
] as const;

const unsupportedProbeSchema = z
  .object({
    previous_response_id: z.unknown().optional(),
    store: z.unknown().optional(),
    background: z.unknown().optional(),
    tools: z
      .array(z.object({ type: z.string() }).catchall(z.unknown()))
      .optional(),
  })
  .passthrough();

const textPartSchema = z
  .object({
    type: z.enum(["input_text", "output_text", "text"]),
    text: z.string(),
  })
  .catchall(z.unknown());

const messageContentSchema = z.union([
  z.string(),
  z.array(textPartSchema).min(1),
]);

const inputMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: messageContentSchema,
});

const functionToolSchema = z.object({
  type: z.literal("function"),
  name: idSchema,
  description: z.string().optional(),
  parameters: z.unknown().optional(),
});

const customToolSchema = z.object({
  type: z.literal("custom"),
  name: idSchema,
  description: z.string().optional(),
  format: z.unknown().optional(),
});

const forbiddenToolSchema = z
  .object({
    type: z.enum(forbiddenToolTypes),
  })
  .catchall(z.unknown());

const toolSchema = z.union([
  functionToolSchema,
  customToolSchema,
  forbiddenToolSchema,
]);

export const OpenAIResponsesRequestSchema = z.object({
  model: idSchema,
  input: z.union([z.string(), z.array(inputMessageSchema).min(1)]),
  tools: z.array(toolSchema).optional(),
  reasoning: z
    .object({
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
      effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
    })
    .optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  parallel_tool_calls: z.boolean().optional(),
  tool_choice: z
    .union([z.enum(["none", "auto", "required"]), looseObjectSchema])
    .optional(),
  store: z.boolean().optional(),
  background: z.boolean().optional(),
});

type RawOpenAIResponsesRequest = z.infer<typeof OpenAIResponsesRequestSchema>;
export type OpenAIResponsesInputMessage = z.infer<typeof inputMessageSchema>;
export type OpenAIResponsesTextPart = z.infer<typeof textPartSchema>;
export type OpenAIResponsesFunctionTool = z.infer<typeof functionToolSchema>;
export type OpenAIResponsesCustomTool = z.infer<typeof customToolSchema>;
export type OpenAIResponsesTool =
  | OpenAIResponsesFunctionTool
  | OpenAIResponsesCustomTool;
export type OpenAIResponsesRequest = Omit<
  RawOpenAIResponsesRequest,
  "tools"
> & {
  readonly tools?: readonly OpenAIResponsesTool[] | undefined;
};

export class OpenAIResponsesUnsupportedFeatureError extends Error {
  readonly code = "UNSUPPORTED_OPENAI_RESPONSES_FEATURE";
  readonly status = 400;

  constructor(
    readonly feature: string,
    readonly path: string,
  ) {
    super(`OpenAI Responses feature is not supported: ${feature} at ${path}`);
    this.name = "OpenAIResponsesUnsupportedFeatureError";
  }
}

export type OpenAIResponsesParseResult =
  | { readonly ok: true; readonly value: OpenAIResponsesRequest }
  | {
      readonly ok: false;
      readonly error: z.ZodError | OpenAIResponsesUnsupportedFeatureError;
    };

export function safeParseOpenAIResponses(
  input: unknown,
): OpenAIResponsesParseResult {
  const unsupported = unsupportedFeature(input);
  if (unsupported !== undefined) {
    return { ok: false, error: unsupported };
  }

  const parsed = OpenAIResponsesRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error };
  }

  return { ok: true, value: supportedRequest(parsed.data) };
}

export function parseOpenAIResponses(input: unknown): OpenAIResponsesRequest {
  const result = safeParseOpenAIResponses(input);
  if (!result.ok) {
    throw result.error;
  }

  return result.value;
}

function unsupportedFeature(
  input: unknown,
): OpenAIResponsesUnsupportedFeatureError | undefined {
  const parsed = unsupportedProbeSchema.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }

  if (parsed.data.previous_response_id !== undefined) {
    return new OpenAIResponsesUnsupportedFeatureError(
      "previous_response_id",
      "previous_response_id",
    );
  }

  if (parsed.data.store === true) {
    return new OpenAIResponsesUnsupportedFeatureError("store", "store");
  }

  if (parsed.data.background === true) {
    return new OpenAIResponsesUnsupportedFeatureError(
      "background",
      "background",
    );
  }

  for (const [index, tool] of (parsed.data.tools ?? []).entries()) {
    if (isForbiddenToolType(tool.type)) {
      return new OpenAIResponsesUnsupportedFeatureError(
        tool.type,
        `tools.${index}.type`,
      );
    }
  }

  return undefined;
}

function supportedRequest(
  request: RawOpenAIResponsesRequest,
): OpenAIResponsesRequest {
  const { tools, ...rest } = request;

  return {
    ...rest,
    ...(tools === undefined ? {} : { tools: tools.map(supportedTool) }),
  };
}

function supportedTool(
  tool: NonNullable<RawOpenAIResponsesRequest["tools"]>[number],
): OpenAIResponsesTool {
  switch (tool.type) {
    case "function":
    case "custom":
      return tool;
    case "computer-use":
    case "computer_use":
    case "computer_use_preview":
    case "file_search":
    case "web_search":
    case "web_search_preview":
    case "image_generation":
      throw new OpenAIResponsesUnsupportedFeatureError(tool.type, "tools.type");
  }

  throw new OpenAIResponsesUnsupportedFeatureError("tool", "tools.type");
}

function isForbiddenToolType(type: string): boolean {
  return forbiddenToolTypes.some((forbidden) => forbidden === type);
}
