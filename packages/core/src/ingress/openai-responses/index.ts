import { compact } from "es-toolkit/array";
import { z } from "zod";
import { OpenAIResponsesUnsupportedFeatureError } from "../../error";
import { openAIResponsesInputItemSchema } from "./input-items";
import { openAIResponsesToolSchema, supportedTools, unsupportedToolFeature } from "./tools";

const idSchema = z.string().min(1);
const looseObjectSchema = z.object({}).catchall(z.unknown());
const unsupportedProbeSchema = z
  .object({
    previous_response_id: z.unknown().optional(),
  })
  .passthrough();

export const OpenAIResponsesRequestSchema = z.object({
  model: idSchema,
  input: z.union([
    z.string(),
    z
      .array(
        z.unknown().transform((item) => {
          const parsed = openAIResponsesInputItemSchema.safeParse(item);
          if (!parsed.success) {
            const type =
              typeof item === "object" && item !== null && "type" in item && typeof item.type === "string"
                ? item.type
                : "unknown";
            console.warn("[aio-proxy] Unsupported OpenAI Responses input item", type);
          }
          return parsed.success ? parsed.data : undefined;
        }),
      )
      .min(1)
      .transform(compact),
  ]),
  tools: z.array(openAIResponsesToolSchema).optional(),
  reasoning: z
    .object({
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
      effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    })
    .optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  parallel_tool_calls: z.boolean().optional(),
  tool_choice: z.union([z.enum(["none", "auto", "required"]), looseObjectSchema]).optional(),
  store: z.boolean().optional(),
  background: z.boolean().optional(),
});

type RawOpenAIResponsesRequest = z.output<typeof OpenAIResponsesRequestSchema>;
export type OpenAIResponsesRequest = Omit<RawOpenAIResponsesRequest, "tools"> & {
  readonly tools?: readonly import("./tools").OpenAIResponsesTool[] | undefined;
};

export type OpenAIResponsesParseResult =
  | { readonly ok: true; readonly value: OpenAIResponsesRequest }
  | {
      readonly ok: false;
      readonly error: z.ZodError | OpenAIResponsesUnsupportedFeatureError;
    };

export function safeParseOpenAIResponses(input: unknown): OpenAIResponsesParseResult {
  const unsupported = unsupportedFeature(input);
  if (unsupported !== undefined) return { ok: false, error: unsupported };

  const parsed = OpenAIResponsesRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error };

  return { ok: true, value: supportedRequest(parsed.data) };
}

export function parseOpenAIResponses(input: unknown): OpenAIResponsesRequest {
  const result = safeParseOpenAIResponses(input);
  if (!result.ok) throw result.error;
  return result.value;
}

function unsupportedFeature(input: unknown): OpenAIResponsesUnsupportedFeatureError | undefined {
  const parsed = unsupportedProbeSchema.safeParse(input);
  if (parsed.success) {
    if (parsed.data.previous_response_id !== undefined) {
      return new OpenAIResponsesUnsupportedFeatureError("previous_response_id", "previous_response_id");
    }
  }

  return unsupportedToolFeature(input);
}

function supportedRequest(request: RawOpenAIResponsesRequest): OpenAIResponsesRequest {
  const { tools, ...rest } = request;
  const supported = supportedTools(tools);
  return {
    ...rest,
    ...(supported === undefined ? {} : { tools: supported }),
  };
}

export type { OpenAIResponsesInputItem, OpenAIResponsesInputMessage, OpenAIResponsesTextPart } from "./input-items";
export type {
  OpenAIResponsesCustomTool,
  OpenAIResponsesFunctionTool,
  OpenAIResponsesTool,
} from "./tools";
