import { fromBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import type { McpArgs, McpToolDefinition } from '../../../gen/agent_pb';
import { fromWireName } from '../../../tool-names';
import type { CursorCompletedToolCall } from '../../mcp-call';
import { CursorProtocolError } from '../../protocol-error';
import {
  appendMcpSnapshot,
  declaresNoArguments,
  decodeMcpArgsMap,
  incompleteSnapshotOmitsMappedFields,
  mergeMcpObjects,
  parseMcpObject,
} from './mcp-input';

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
  if (state.committed) return;
  if (args?.smartModeApprovalOnly) {
    dropMcpApprovalProbe(state, outerId, args);
    return;
  }
  const outer = outerId || undefined;
  const nested = args?.toolCallId || undefined;
  const name = args === undefined ? undefined : fromWireName(args.toolName || args.name) || undefined;
  const byOuter = outer === undefined ? undefined : state.outerAliases.get(outer);
  const byNested = nested === undefined ? undefined : state.nestedAliases.get(nested);
  const conflict = () => new CursorProtocolError('cursor_tool_identity_conflict', 'Cursor MCP identity conflicts.');
  const mergedSplit = byOuter !== undefined && byNested !== undefined && byOuter !== byNested;
  let key = mergedSplit
    ? mergeCompatibleMcpCalls(state, byOuter, byNested, outer!, nested!, name)
    : (byOuter ?? byNested);
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
    const announced = state.earlyAnnounce.get(outer);
    if (announced !== undefined) call.announceOrder = Math.min(call.announceOrder, announced);
    call.buffer = appendMcpSnapshot(call.buffer, state.earlySnapshots.get(outer) ?? '');
    state.earlySnapshots.delete(outer);
    state.earlyAnnounce.delete(outer);
  }
  if (nested !== undefined) {
    call.nestedToolCallId = nested;
    state.nestedAliases.set(nested, key);
  }
  applyMcpEvent(call, event, args, snapshot);
  if (!call.nestedToolCallId) call.input = undefined;
  if (mergedSplit || before !== JSON.stringify(call)) {
    state.revision++;
    state.progressRevision++;
  }
}

function dropMcpApprovalProbe(state: McpState, outerId: string | undefined, args: McpArgs | undefined): void {
  const outer = outerId || undefined;
  const nested = args?.toolCallId || undefined;
  const keys = new Set<string>();
  if (outer !== undefined) {
    const key = state.outerAliases.get(outer);
    if (key !== undefined) keys.add(key);
  }
  if (nested !== undefined) {
    const key = state.nestedAliases.get(nested);
    if (key !== undefined) keys.add(key);
  }
  let changed = false;
  if (outer !== undefined && (state.earlySnapshots.has(outer) || state.earlyAnnounce.has(outer))) {
    state.earlySnapshots.delete(outer);
    state.earlyAnnounce.delete(outer);
    changed = true;
  }
  for (const key of keys) {
    const call = state.calls.get(key);
    if (call === undefined) continue;
    state.calls.delete(key);
    changed = true;
    for (const aliases of [state.outerAliases, state.nestedAliases]) {
      for (const [id, mapped] of aliases) if (mapped === key) aliases.delete(id);
    }
  }
  if (changed) {
    state.revision++;
    state.progressRevision++;
  }
}

function mergeCompatibleMcpCalls(
  state: McpState,
  outerKey: string,
  nestedKey: string,
  outer: string,
  nested: string,
  name: string | undefined,
): string {
  const left = state.calls.get(outerKey);
  const right = state.calls.get(nestedKey);
  const conflict = () => new CursorProtocolError('cursor_tool_identity_conflict', 'Cursor MCP identity conflicts.');
  if (left === undefined || right === undefined) throw conflict();
  if (left.nestedToolCallId && left.nestedToolCallId !== nested) throw conflict();
  if (right.outerBound !== undefined && right.outerBound !== outer) throw conflict();
  if (left.toolName !== right.toolName || (name !== undefined && left.toolName !== name)) throw conflict();
  const keep = left.announceOrder <= right.announceOrder ? left : right;
  const drop = keep === left ? right : left;
  const keepKey = keep === left ? outerKey : nestedKey;
  const dropKey = keep === left ? nestedKey : outerKey;
  keep.outerBound = outer;
  keep.outerCallId = outer;
  keep.nestedToolCallId = nested;
  keep.announceOrder = Math.min(keep.announceOrder, drop.announceOrder);
  keep.buffer = appendMcpSnapshot(keep.buffer, drop.buffer);
  keep.completion = mergeMcpObjects(keep.completion, drop.completion);
  keep.exec = mergeMcpObjects(keep.exec, drop.exec);
  keep.sawCompletion ||= drop.sawCompletion;
  keep.sawExec ||= drop.sawExec;
  keep.allowsEmpty ||= drop.allowsEmpty;
  keep.input = undefined;
  state.calls.delete(dropKey);
  for (const aliases of [state.outerAliases, state.nestedAliases]) {
    for (const [id, key] of aliases) if (key === dropKey) aliases.set(id, keepKey);
  }
  state.outerAliases.set(outer, keepKey);
  state.nestedAliases.set(nested, keepKey);
  return keepKey;
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
  if (
    hasBadSnapshot &&
    !call.sawExec &&
    incompleteSnapshotOmitsMappedFields(call.buffer, mergeMcpObjects(call.completion, call.exec))
  ) {
    call.input = undefined;
    return;
  }
  if ((!call.sawCompletion && !call.sawExec) || (!hasFinalFields && !explicitEmpty)) {
    call.input = undefined;
    return;
  }
  call.input = JSON.stringify(mergeMcpObjects(mergeMcpObjects(buffered, call.completion), call.exec));
}
