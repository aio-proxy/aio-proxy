import { z } from "zod";
import { OpenAIResponsesUnsupportedFeatureError } from "../../error";

const idSchema = z.string().min(1);
const forbiddenToolTypes = [
  "computer-use",
  "computer_use",
  "computer_use_preview",
  "file_search",
  "web_search",
  "web_search_preview",
  "image_generation",
] as const;

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

const toolsProbeSchema = z
  .object({
    tools: z.array(z.object({ type: z.string() }).catchall(z.unknown())).optional(),
  })
  .passthrough();

export const openAIResponsesToolSchema = z.union([functionToolSchema, customToolSchema, forbiddenToolSchema]);

type RawOpenAIResponsesTool = z.output<typeof openAIResponsesToolSchema>;
export type OpenAIResponsesFunctionTool = z.output<typeof functionToolSchema>;
export type OpenAIResponsesCustomTool = z.output<typeof customToolSchema>;
export type OpenAIResponsesTool = OpenAIResponsesFunctionTool | OpenAIResponsesCustomTool;

export function unsupportedToolFeature(input: unknown): OpenAIResponsesUnsupportedFeatureError | undefined {
  const parsed = toolsProbeSchema.safeParse(input);
  if (!parsed.success) return undefined;

  for (const [index, tool] of (parsed.data.tools ?? []).entries()) {
    if (forbiddenToolTypes.some((forbidden) => forbidden === tool.type)) {
      return new OpenAIResponsesUnsupportedFeatureError(tool.type, `tools.${index}.type`);
    }
  }

  return undefined;
}

export function supportedTools(
  tools: readonly RawOpenAIResponsesTool[] | undefined,
): readonly OpenAIResponsesTool[] | undefined {
  return tools?.map(supportedTool);
}

function supportedTool(tool: RawOpenAIResponsesTool): OpenAIResponsesTool {
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
