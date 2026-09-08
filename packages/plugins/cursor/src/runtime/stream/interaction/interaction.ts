import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';

import type { InteractionUpdate, McpArgs, McpToolDefinition, ToolCall } from '../../../gen/agent_pb';
import type { CursorCompletedToolCall } from '../../mcp-call';
import { createMcpState, readMcpState, readReadyMcpCalls, updateMcp, type McpState } from './mcp-state';

export type CursorStreamAccumulator = {
  textId?: string | undefined;
  reasoningId?: string | undefined;
  mcp: McpState;
  outputTokens: number;
  sawTokenDelta: boolean;
  sawTurnEnded: boolean;
  toolCalls: number;
};

export function createCursorStreamAccumulator(tools: readonly McpToolDefinition[] = []): CursorStreamAccumulator {
  return {
    mcp: createMcpState(tools),
    outputTokens: 0,
    sawTokenDelta: false,
    sawTurnEnded: false,
    toolCalls: 0,
  };
}

export function cursorToolState(a: CursorStreamAccumulator) {
  return readMcpState(a.mcp);
}

export function cursorCompletedTools(a: CursorStreamAccumulator): readonly CursorCompletedToolCall[] {
  return readReadyMcpCalls(a.mcp);
}

export function commitCursorTools(a: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
  const state = cursorToolState(a);
  if (a.mcp.committed || state.openCount > 0 || state.readyCount === 0) return [];
  a.mcp.committed = true;
  const parts: LanguageModelV4StreamPart[] = [...closeText(a), ...closeReasoning(a)];
  for (const call of cursorCompletedTools(a)) {
    parts.push(
      { type: 'tool-input-start', id: call.outerCallId, toolName: call.toolName },
      { type: 'tool-input-delta', id: call.outerCallId, delta: call.input },
      { type: 'tool-input-end', id: call.outerCallId },
      { type: 'tool-call', toolCallId: call.outerCallId, toolName: call.toolName, input: call.input },
    );
    a.toolCalls++;
  }
  return parts;
}

// Pure mapping of ONE interactionUpdate payload into ordered V4 parts; mutates
// the accumulator. Native/todo tool starts are dropped (surfaced as A-class
// exec, not model output). MCP mapping only collects identity/args; tool parts
// are produced later by commitCursorTools.
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
      updateMcp(accumulator.mcp, 'start', message.value.callId, mcpArgsOf(message.value.toolCall));
      return [];
    case 'partialToolCall':
      updateMcp(
        accumulator.mcp,
        'partial',
        message.value.callId,
        mcpArgsOf(message.value.toolCall),
        message.value.argsTextDelta,
      );
      return [];
    case 'toolCallDelta':
      return [];
    case 'toolCallCompleted':
      updateMcp(accumulator.mcp, 'complete', message.value.callId, mcpArgsOf(message.value.toolCall));
      return [];
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
  updateMcp(accumulator.mcp, 'exec', undefined, mcp);
  return [];
}

export function finalizeCursorStream(accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [];
  parts.push(...closeText(accumulator));
  parts.push(...closeReasoning(accumulator));
  parts.push({ type: 'finish', usage: usageOf(accumulator), finishReason: finishReasonOf(accumulator) });
  return parts;
}

function mcpArgsOf(toolCall: ToolCall | undefined): McpArgs | undefined {
  const tool = toolCall?.tool;
  if (tool?.case !== 'mcpToolCall') return undefined;
  return tool.value.args;
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
