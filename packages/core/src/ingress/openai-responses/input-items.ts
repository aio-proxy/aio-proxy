import { z } from "zod";
import { OpenAIResponsesUnsupportedFeatureError } from "../../error";

const idSchema = z.string().min(1);
const unsupportedItemTypes = [
  "computer_call",
  "computer_call_output",
  "shell_call",
  "shell_call_output",
  "apply_patch_call",
  "apply_patch_call_output",
  "file_search_call",
  "file_search_call_output",
] as const;

const textPartSchema = z
  .object({
    type: z.enum(["input_text", "output_text", "text"]),
    text: z.string(),
  })
  .catchall(z.unknown());

const messageContentSchema = z.union([z.string(), z.array(textPartSchema).min(1)]);

const inputMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: messageContentSchema,
});

const functionOutputContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input_text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("input_image"),
    image_url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
  z.object({
    type: z.literal("input_file"),
    file_id: z.string().optional(),
    file_data: z.string().optional(),
    filename: z.string().optional(),
  }),
]);

const functionCallItemSchema = z.object({
  type: z.literal("function_call"),
  call_id: idSchema,
  name: idSchema,
  arguments: z.string(),
  id: idSchema.optional(),
});

const functionCallOutputItemSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: idSchema,
  output: z.union([z.string(), z.array(functionOutputContentPartSchema).min(1)]),
});

const reasoningItemSchema = z.object({
  type: z.literal("reasoning"),
  id: idSchema.optional(),
  encrypted_content: z.string().nullable().optional(),
  summary: z.array(
    z.object({
      type: z.literal("summary_text"),
      text: z.string(),
    }),
  ),
});

const itemReferenceSchema = z.object({
  type: z.literal("item_reference"),
  id: idSchema,
});

export const openAIResponsesInputItemSchema = z.union([
  inputMessageSchema,
  functionCallItemSchema,
  functionCallOutputItemSchema,
  reasoningItemSchema,
  itemReferenceSchema,
]);

export type OpenAIResponsesInputMessage = z.output<typeof inputMessageSchema>;
export type OpenAIResponsesInputItem = z.output<typeof openAIResponsesInputItemSchema>;
export type OpenAIResponsesTextPart = z.output<typeof textPartSchema>;

export function unsupportedInputItemFeature(input: unknown): OpenAIResponsesUnsupportedFeatureError | undefined {
  if (typeof input !== "object" || input === null || !("input" in input) || !Array.isArray(input.input)) {
    return undefined;
  }

  for (const [index, item] of input.input.entries()) {
    if (typeof item !== "object" || item === null || !("type" in item) || typeof item.type !== "string") continue;
    if (unsupportedItemTypes.some((type) => type === item.type)) {
      return new OpenAIResponsesUnsupportedFeatureError(item.type, `input.${index}.type`);
    }
  }

  return undefined;
}
