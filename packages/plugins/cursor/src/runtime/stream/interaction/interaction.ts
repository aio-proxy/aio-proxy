import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { fromBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import type { InteractionUpdate, McpArgs } from '../../../gen/agent_pb';
import { fromWireName } from '../../../tool-names';

export type CursorStreamAccumulator = {
  textId?: string | undefined;
  reasoningId?: string | undefined;
  tools: Map<string, { nestedToolCallId: string; toolName: string; buffer: string }>;
  completedToolCalls: Map<string, string>;
  outputTokens: number;
  sawTokenDelta: boolean;
  sawTurnEnded: boolean;
  toolCalls: number;
};

export function createCursorStreamAccumulator(): CursorStreamAccumulator {
  return {
    tools: new Map(),
    completedToolCalls: new Map(),
    outputTokens: 0,
    sawTokenDelta: false,
    sawTurnEnded: false,
    toolCalls: 0,
  };
}

// Pure mapping of ONE interactionUpdate payload into ordered V4 parts; mutates
// the accumulator. Native/todo tool starts are dropped (surfaced as A-class
// exec, not model output). Exactly one V4 tool-call is emitted per completed
// MCP call, with fromWireName applied to un-escape reserved tool names.
export function mapInteractionUpdate(
  update: InteractionUpdate,
  accumulator: CursorStreamAccumulator,
): LanguageModelV4StreamPart[] {
  const message = update.message;
  switch (message.case) {
    case 'textDelta':
      return openAndDeltaText(accumulator, message.value.text ?? '');
    case 'thinkingDelta':
      return openAndDeltaReasoning(accumulator, message.value.text ?? '');
    case 'thinkingCompleted':
      return closeReasoning(accumulator);
    case 'toolCallStarted':
      return startMcpTool(accumulator, message.value);
    case 'partialToolCall':
    case 'toolCallDelta':
      return deltaMcpTool(accumulator, message.value);
    case 'toolCallCompleted':
      return completeMcpTool(accumulator, message.value);
    case 'tokenDelta':
      accumulator.outputTokens += message.value.tokens ?? 0;
      accumulator.sawTokenDelta = true;
      return [];
    case 'turnEnded':
      accumulator.sawTurnEnded = true;
      return [];
    default:
      return [];
  }
}

export function mapMcpExec(mcp: McpArgs, accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
  const nestedToolCallId = mcp.toolCallId || crypto.randomUUID();
  const outerCallId =
    [...accumulator.tools].find(([, tool]) => tool.nestedToolCallId === nestedToolCallId)?.[0] ?? nestedToolCallId;
  const value = {
    callId: outerCallId,
    toolCall: {
      tool: {
        case: 'mcpToolCall',
        value: { args: { ...mcp, name: mcp.name || mcp.toolName, toolCallId: nestedToolCallId } },
      },
    },
  };
  return [
    ...(accumulator.tools.has(outerCallId) ? [] : startMcpTool(accumulator, value)),
    ...completeMcpTool(accumulator, value),
  ];
}

export function finalizeCursorStream(accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [];
  parts.push(...closeText(accumulator));
  parts.push(...closeReasoning(accumulator));
  parts.push({ type: 'finish', usage: usageOf(accumulator), finishReason: finishReasonOf(accumulator) });
  return parts;
}

function openAndDeltaText(accumulator: CursorStreamAccumulator, delta: string): LanguageModelV4StreamPart[] {
  if (delta.length === 0) return [];
  const parts: LanguageModelV4StreamPart[] = [...closeReasoning(accumulator)];
  if (accumulator.textId === undefined) {
    accumulator.textId = crypto.randomUUID();
    parts.push({ type: 'text-start', id: accumulator.textId });
  }
  parts.push({ type: 'text-delta', id: accumulator.textId, delta });
  return parts;
}

function closeText(accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
  if (accumulator.textId === undefined) return [];
  const id = accumulator.textId;
  accumulator.textId = undefined;
  return [{ type: 'text-end', id }];
}

function openAndDeltaReasoning(accumulator: CursorStreamAccumulator, delta: string): LanguageModelV4StreamPart[] {
  if (delta.length === 0) return [];
  const parts: LanguageModelV4StreamPart[] = [...closeText(accumulator)];
  if (accumulator.reasoningId === undefined) {
    accumulator.reasoningId = crypto.randomUUID();
    parts.push({ type: 'reasoning-start', id: accumulator.reasoningId });
  }
  parts.push({ type: 'reasoning-delta', id: accumulator.reasoningId, delta });
  return parts;
}

function closeReasoning(accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
  if (accumulator.reasoningId === undefined) return [];
  const id = accumulator.reasoningId;
  accumulator.reasoningId = undefined;
  return [{ type: 'reasoning-end', id }];
}

function startMcpTool(accumulator: CursorStreamAccumulator, value: unknown): LanguageModelV4StreamPart[] {
  const mcp = mcpArgsOf(value);
  const outerCallId = (value as { callId?: string } | undefined)?.callId;
  if (mcp === undefined || !outerCallId) return [];
  const parts: LanguageModelV4StreamPart[] = [...closeText(accumulator), ...closeReasoning(accumulator)];
  const toolName = fromWireName(mcp.name);
  accumulator.tools.set(outerCallId, { nestedToolCallId: mcp.toolCallId, toolName, buffer: '' });
  return [...parts, { type: 'tool-input-start', id: outerCallId, toolName }];
}

function deltaMcpTool(
  accumulator: CursorStreamAccumulator,
  value: { argsTextDelta?: string; callId?: string },
): LanguageModelV4StreamPart[] {
  const outerCallId = value.callId;
  if (outerCallId === undefined) return [];
  const tool = accumulator.tools.get(outerCallId);
  if (tool === undefined) return [];
  const snapshot = value.argsTextDelta ?? '';
  const chunk = snapshot.startsWith(tool.buffer) ? snapshot.slice(tool.buffer.length) : snapshot;
  if (chunk.length === 0) return [];
  tool.buffer += chunk;
  return [{ type: 'tool-input-delta', id: outerCallId, delta: chunk }];
}

function completeMcpTool(accumulator: CursorStreamAccumulator, value: unknown): LanguageModelV4StreamPart[] {
  const outerCallId = (value as { callId?: string } | undefined)?.callId;
  const tool = outerCallId === undefined ? undefined : accumulator.tools.get(outerCallId);
  if (tool === undefined || outerCallId === undefined) return [];
  const mcp = mcpArgsOf(value);
  const decoded = mcp ? decodeMcpArgsMap(mcp.args) : undefined;
  const input = decoded !== undefined ? JSON.stringify(decoded) : tool.buffer.length > 0 ? tool.buffer : '{}';
  accumulator.tools.delete(outerCallId);
  accumulator.completedToolCalls.set(outerCallId, tool.nestedToolCallId);
  accumulator.toolCalls += 1;
  return [
    { type: 'tool-input-end', id: outerCallId },
    { type: 'tool-call', toolCallId: outerCallId, toolName: tool.toolName, input },
  ];
}

function mcpArgsOf(
  value: unknown,
): { name: string; toolCallId: string; args?: Record<string, Uint8Array> } | undefined {
  const toolCall = (value as { toolCall?: { tool?: { case?: string; value?: unknown } } } | undefined)?.toolCall;
  if (toolCall?.tool?.case !== 'mcpToolCall') return undefined;
  const args = (
    toolCall.tool.value as
      | { args?: { name?: string; toolCallId?: string; args?: Record<string, Uint8Array> } }
      | undefined
  )?.args;
  if (!args) return undefined;
  return {
    name: args.name ?? '',
    toolCallId: args.toolCallId && args.toolCallId.length > 0 ? args.toolCallId : crypto.randomUUID(),
    ...(args.args === undefined ? {} : { args: args.args }),
  };
}

function decodeMcpArgsMap(args: Record<string, Uint8Array> | undefined): Record<string, unknown> | undefined {
  if (!args || Object.keys(args).length === 0) return undefined;
  const decoded: Record<string, unknown> = {};
  for (const [key, bytes] of Object.entries(args)) decoded[key] = decodeMcpArgValue(bytes);
  return decoded;
}

function decodeMcpArgValue(bytes: Uint8Array): unknown {
  try {
    const json = toJson(ValueSchema, fromBinary(ValueSchema, bytes));
    if (typeof json === 'string') return safeJson(json);
    return json;
  } catch {
    return safeJson(new TextDecoder().decode(bytes));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function usageOf(accumulator: CursorStreamAccumulator): LanguageModelV4Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: {
      total: accumulator.sawTokenDelta ? accumulator.outputTokens : undefined,
      text: undefined,
      reasoning: undefined,
    },
  };
}

function finishReasonOf(accumulator: CursorStreamAccumulator): LanguageModelV4FinishReason {
  return accumulator.toolCalls > 0 ? { unified: 'tool-calls', raw: undefined } : { unified: 'stop', raw: undefined };
}
