import { z } from "zod";

const idSchema = z.string().min(1);

export const functionToolSchema = z.object({
  type: z.literal("function"),
  name: idSchema,
  description: z.string().optional(),
  parameters: z.unknown().optional(),
  strict: z.boolean().optional(),
  defer_loading: z.boolean().optional(),
});

export const customToolSchema = z.object({
  type: z.literal("custom"),
  name: idSchema,
  description: z.string().optional(),
  format: z.unknown().optional(),
});

export const namespaceToolSchema = z.object({
  type: z.literal("namespace"),
  name: idSchema,
  description: z.string().optional(),
  tools: z.array(functionToolSchema).min(1),
});

const executableToolSchema = z.union([functionToolSchema, customToolSchema, namespaceToolSchema]);
const knownToolTypes = new Set(["function", "custom", "namespace"]);

const unsupportedToolSchema = z.object({
  type: z.literal("__aio_proxy_unsupported_tool__"),
  wireType: idSchema,
});

export const openAIResponsesToolSchema = z.unknown().transform((tool, context) => {
  const parsed = executableToolSchema.safeParse(tool);
  if (parsed.success) return parsed.data;

  const wireType = safeToolType(tool);
  if (wireType !== undefined && !knownToolTypes.has(wireType)) {
    return { type: "__aio_proxy_unsupported_tool__" as const, wireType };
  }

  context.addIssue({ code: "custom", message: "Invalid OpenAI Responses tool" });
  return z.NEVER;
});

export type OpenAIResponsesFunctionTool = z.output<typeof functionToolSchema>;
export type OpenAIResponsesCustomTool = z.output<typeof customToolSchema>;
export type OpenAIResponsesNamespaceTool = z.output<typeof namespaceToolSchema>;
export type OpenAIResponsesUnsupportedTool = z.output<typeof unsupportedToolSchema>;
export type OpenAIResponsesExecutableTool =
  | OpenAIResponsesFunctionTool
  | OpenAIResponsesCustomTool
  | OpenAIResponsesNamespaceTool;
export type OpenAIResponsesTool = OpenAIResponsesExecutableTool | OpenAIResponsesUnsupportedTool;

function safeToolType(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
    ? value.type
    : undefined;
}
