import { fromBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import type { McpArgs, McpToolDefinition } from '../../../gen/agent_pb';
import { fromWireName } from '../../../tool-names';
import type { CursorCompletedToolCall } from '../../mcp-call';
import { CursorProtocolError } from '../../protocol-error';
import { appendMcpSnapshot, declaresNoArguments, decodeMcpArgsMap, mergeMcpObjects, parseMcpObject } from './mcp-input';

type McpCall = {
  outerCallId: string;
  outerBound?: string;
  nestedToolCallId: string;
  toolName: string;
  announceOrder: number;
  buffer: string;
  completion?: Record<string, unknown>;
  exec?: Record<string, unknown>;
  sawCompletion: boolean;
  sawExec: boolean;
  allowsEmpty: boolean;
  input?: string;
};

export type McpState = {
  calls: Map<string, McpCall>;
  outerAliases: Map<string, string>;
  nestedAliases: Map<string, string>;
  earlySnapshots: Map<string, string>;
  earlyAnnounce: Map<string, number>;
  nextAnnounce: number;
  emptyTools: Set<string>;
  revision: number;
  progressRevision: number;
  committed: boolean;
};

export function createMcpState(tools: readonly McpToolDefinition[]): McpState {
  const emptyTools = new Set<string>();
  for (const tool of tools) {
    try {
      if (declaresNoArguments(toJson(ValueSchema, fromBinary(ValueSchema, tool.inputSchema)))) {
        emptyTools.add(fromWireName(tool.name));
      }
    } catch {
      /* An unreadable declaration is not proof of empty input. */
    }
  }
  return {
    calls: new Map(),
    outerAliases: new Map(),
    nestedAliases: new Map(),
    earlySnapshots: new Map(),
    earlyAnnounce: new Map(),
    nextAnnounce: 0,
    emptyTools,
    revision: 0,
    progressRevision: 0,
    committed: false,
  };
}

export function readReadyMcpCalls(state: McpState): readonly CursorCompletedToolCall[] {
  return [...state.calls.values()]
    .filter((call) => call.input !== undefined)
    .sort((left, right) => left.announceOrder - right.announceOrder)
    .map((call) => ({
      outerCallId: call.outerCallId,
      nestedToolCallId: call.nestedToolCallId,
      toolName: call.toolName,
      input: call.input!,
    }));
}

export function readMcpState(state: McpState) {
  const readyCount = readReadyMcpCalls(state).length;
  return {
    openCount: state.calls.size - readyCount,
    readyCount,
    revision: state.revision,
    progressRevision: state.progressRevision,
  };
}

export function updateMcp(
  state: McpState,
  event: 'start' | 'partial' | 'complete' | 'exec',
  outerId: string | undefined,
  args: McpArgs | undefined,
  snapshot?: string,
): void {
  if (state.committed || args?.smartModeApprovalOnly) return;
  const outer = outerId || undefined;
  const nested = args?.toolCallId || undefined;
  const name = args === undefined ? undefined : fromWireName(args.toolName || args.name) || undefined;
  const byOuter = outer === undefined ? undefined : state.outerAliases.get(outer);
  const byNested = nested === undefined ? undefined : state.nestedAliases.get(nested);
  const conflict = () => new CursorProtocolError('cursor_tool_identity_conflict', 'Cursor MCP identity conflicts.');
  if (byOuter !== undefined && byNested !== undefined && byOuter !== byNested) throw conflict();
  let key = byOuter ?? byNested;
  if (key === undefined && args === undefined) {
    if (outer !== undefined && snapshot !== undefined) {
      const previous = state.earlySnapshots.get(outer) ?? '';
      const next = appendMcpSnapshot(previous, snapshot);
      if (next !== previous) {
        if (!state.earlyAnnounce.has(outer)) state.earlyAnnounce.set(outer, state.nextAnnounce++);
        state.earlySnapshots.set(outer, next);
        state.revision++;
        state.progressRevision++;
      }
    }
    return;
  }
  if (key === undefined && ((outer === undefined && nested === undefined) || name === undefined)) throw conflict();
  key ??= outer === undefined ? 'nested:' + nested : 'outer:' + outer;
  let call = state.calls.get(key);
  const before = call === undefined ? undefined : JSON.stringify(call);
  if (call === undefined) {
    call = {
      outerCallId: outer ?? nested!,
      ...(outer === undefined ? {} : { outerBound: outer }),
      nestedToolCallId: nested ?? '',
      toolName: name!,
      announceOrder: (outer === undefined ? undefined : state.earlyAnnounce.get(outer)) ?? state.nextAnnounce++,
      buffer: '',
      sawCompletion: false,
      sawExec: false,
      allowsEmpty: state.emptyTools.has(name!),
    };
    state.calls.set(key, call);
  }
  if (outer !== undefined && call.outerBound !== undefined && call.outerBound !== outer) throw conflict();
  if (nested !== undefined && call.nestedToolCallId && call.nestedToolCallId !== nested) throw conflict();
  if (name !== undefined && call.toolName !== name) throw conflict();
  if (outer !== undefined) {
    call.outerBound = outer;
    call.outerCallId = outer;
    state.outerAliases.set(outer, key);
    call.buffer = appendMcpSnapshot(call.buffer, state.earlySnapshots.get(outer) ?? '');
    state.earlySnapshots.delete(outer);
  }
  if (nested !== undefined) {
    call.nestedToolCallId = nested;
    state.nestedAliases.set(nested, key);
  }
  applyMcpEvent(call, event, args, snapshot);
  if (!call.nestedToolCallId) call.input = undefined;
  if (before !== JSON.stringify(call)) {
    state.revision++;
    state.progressRevision++;
  }
}

function applyMcpEvent(
  call: McpCall,
  event: 'start' | 'partial' | 'complete' | 'exec',
  args: McpArgs | undefined,
  snapshot: string | undefined,
): void {
  if (snapshot !== undefined) call.buffer = appendMcpSnapshot(call.buffer, snapshot);
  const decoded = args === undefined ? undefined : decodeMcpArgsMap(args.args);
  if (event === 'complete') {
    call.sawCompletion = true;
    call.completion = mergeMcpObjects(call.completion, decoded);
  }
  if (event === 'exec') {
    call.sawExec = true;
    call.exec = mergeMcpObjects(call.exec, decoded);
  }
  const buffered = parseMcpObject(call.buffer);
  const hasFinalFields = Object.keys(call.completion ?? {}).length > 0 || Object.keys(call.exec ?? {}).length > 0;
  const hasBadSnapshot = call.buffer.trim().length > 0 && buffered === undefined;
  const explicitEmpty =
    call.sawExec || buffered !== undefined || (call.sawCompletion && call.allowsEmpty && !hasBadSnapshot);
  if ((!call.sawCompletion && !call.sawExec) || (!hasFinalFields && !explicitEmpty)) {
    call.input = undefined;
    return;
  }
  call.input = JSON.stringify(mergeMcpObjects(mergeMcpObjects(buffered, call.completion), call.exec));
}
