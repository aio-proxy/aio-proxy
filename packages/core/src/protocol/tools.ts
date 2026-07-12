import { z } from "zod";
import type { JSONValue, ToolSet } from "../ai-sdk-bridge";
import { jsonSchema } from "../ai-sdk-bridge";

const jsonValueSchema = z.json();

export type FunctionToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
};

export function functionToolSet(tools: readonly FunctionToolDefinition[] | undefined): ToolSet | undefined {
  if (tools === undefined) {
    return undefined;
  }

  const result: ToolSet = Object.create(null);
  for (const tool of tools) {
    result[tool.name] = {
      type: "function",
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: jsonSchema(jsonSchemaObject(tool.inputSchema)),
      outputSchema: jsonSchema({}),
    };
  }
  return result;
}

function jsonSchemaObject(value: unknown): Parameters<typeof jsonSchema>[0] {
  const parsed = jsonValue(value);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function jsonValue(value: unknown): JSONValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
