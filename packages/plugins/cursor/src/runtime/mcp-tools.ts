import {
  InvalidArgumentError,
  type LanguageModelV4CallOptions,
  type LanguageModelV4FunctionTool,
} from '@ai-sdk/provider';
import { create, fromJson, toBinary } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import { type McpToolDefinition, McpToolDefinitionSchema } from '../gen/agent_pb';
import { toWireName } from '../tool-names';

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {}, required: [] } as const;

// Cursor addresses every forwarded tool under one synthetic MCP provider.
const AIO_PROXY_MCP_PROVIDER = 'pi-agent';

// Convert caller function tools into Cursor McpToolDefinition messages. Reserved
// names are escaped via toWireName so they never shadow Cursor native tools, and
// the JSON Schema is carried as protobuf Value bytes exactly as Cursor expects.
export function buildMcpToolDefinitions(
  tools: LanguageModelV4CallOptions['tools'],
  toolChoice?: LanguageModelV4CallOptions['toolChoice'],
): McpToolDefinition[] {
  if (!tools || tools.length === 0 || toolChoice?.type === 'none') return [];
  const functionTools = tools.filter((tool): tool is LanguageModelV4FunctionTool => tool.type === 'function');
  const selectedTools =
    toolChoice?.type === 'tool' ? functionTools.filter((tool) => tool.name === toolChoice.toolName) : functionTools;
  if (toolChoice?.type === 'tool' && selectedTools.length === 0) {
    throw new InvalidArgumentError({
      argument: 'toolChoice',
      message: `toolChoice references unavailable function tool '${toolChoice.toolName}'.`,
    });
  }
  return selectedTools.map((tool) => {
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
