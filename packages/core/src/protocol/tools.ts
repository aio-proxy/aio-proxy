import type { JSONObject, JSONSchema7 } from '@ai-sdk/provider';
import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import type { JSONValue, ToolSet } from '../ai-sdk-bridge';
import { jsonSchema } from '../ai-sdk-bridge';

const jsonValueSchema = z.json();

export type FunctionToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly strict?: boolean;
  readonly metadata?: JSONObject;
};

export function functionToolSet(tools: readonly FunctionToolDefinition[] | undefined): ToolSet | undefined {
  if (tools === undefined) {
    return undefined;
  }

  const result: ToolSet = Object.create(null);
  for (const tool of tools) {
    result[tool.name] = {
      type: 'function',
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: jsonSchema(jsonSchemaObject(tool.inputSchema)),
      outputSchema: jsonSchema({}),
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      ...(tool.metadata === undefined ? {} : { metadata: tool.metadata }),
    };
  }
  return result;
}

function jsonSchemaObject(value: unknown): JSONSchema7 {
  const parsed = jsonValue(value);
  // Tool schemas arrive verbatim from client wire payloads. `JSONSchema7` types each keyword, so no
  // plain JSON object is structurally assignable to it; we confirm it is a JSON object and forward it
  // unvalidated rather than checking it against the JSON Schema meta-schema, which is the upstream
  // provider's job. A non-object degrades to an empty schema instead of throwing.
  return isPlainObject(parsed) ? (parsed as JSONSchema7) : {};
}

function jsonValue(value: unknown): JSONValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
