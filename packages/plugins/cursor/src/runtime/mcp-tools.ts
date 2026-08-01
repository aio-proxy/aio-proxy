import { create, fromJson, toBinary } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import { type McpToolDefinition, McpToolDefinitionSchema } from '../gen/agent_pb';
import { toWireName } from '../tool-names';

// Minimal shape of a caller-declared function tool we forward to Cursor.
export type LanguageModelV4FunctionTool = {
  readonly type: 'function';
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
};

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {}, required: [] } as const;

// Cursor addresses every forwarded tool under one synthetic MCP provider.
const AIO_PROXY_MCP_PROVIDER = 'pi-agent';

// Convert caller function tools into Cursor McpToolDefinition messages. Reserved
// names are escaped via toWireName so they never shadow Cursor native tools, and
// the JSON Schema is carried as protobuf Value bytes exactly as Cursor expects.
export function buildMcpToolDefinitions(
  tools: readonly LanguageModelV4FunctionTool[] | undefined,
): McpToolDefinition[] {
  if (!tools || tools.length === 0) return [];
  return tools
    .filter((tool) => tool.type === 'function')
    .map((tool) => {
      const wireName = toWireName(tool.name);
      const schemaValue =
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? (tool.inputSchema as Record<string, unknown>)
          : EMPTY_OBJECT_SCHEMA;
      const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, schemaValue as never));
      return create(McpToolDefinitionSchema, {
        name: wireName,
        description: tool.description ?? '',
        providerIdentifier: AIO_PROXY_MCP_PROVIDER,
        toolName: wireName,
        inputSchema,
      });
    });
}
