import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ClientHeartbeatSchema,
  type ConversationStateStructure,
  type McpToolDefinition,
} from '../../gen/agent_pb';
import { CONNECT_END_STREAM_FLAG, frameConnectMessage, parseConnectEndStream } from '../../wire/frame';
import type { CursorH2Stream, CursorTransport } from '../../wire/transport';
import { encodeExecResponse, encodeKvResponse, encodeMcpApprovalRejection } from '../client-messages';
import { encodeInteractionReply } from '../interaction-query';
import type { CursorCompletedToolCall } from '../mcp-call';
import {
  commitCursorTools,
  createCursorStreamAccumulator,
  cursorCompletedTools,
  cursorToolState,
  finalizeCursorStream,
  mapInteractionUpdate,
  mapMcpExec,
  type CursorStreamAccumulator,
} from '../stream';

export type CursorRunTiming = {
  firstFrameTimeoutMs: number;
  frameSilenceTimeoutMs: number;
  noProgressTimeoutMs: number;
  toolHandoffGraceMs: number;
  turnEndGraceMs: number;
};

export type CursorTurnResult = {
  readonly conversationState: ConversationStateStructure;
  readonly checkpointUsable: boolean;
  readonly pendingToolCalls: Map<string, string>;
  readonly toolCalls: readonly CursorCompletedToolCall[];
  readonly assistantText: string;
  readonly blobStore: Map<string, Uint8Array>;
};

export function runCursorTurn(input: {
  readonly transport: CursorTransport;
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
  readonly requestBytes: Uint8Array;
  readonly initialConversationState: ConversationStateStructure;
  readonly requestContextTools: McpToolDefinition[];
  readonly blobStore: Map<string, Uint8Array>;
  readonly heartbeatMs?: number;
  readonly timing?: Partial<CursorRunTiming>;
}): { stream: ReadableStream<LanguageModelV4StreamPart>; result: Promise<CursorTurnResult> } {
  const accumulator = createCursorStreamAccumulator(input.requestContextTools);
  let conversationState = input.initialConversationState;
  let sawCheckpoint = false;
  let settle!: (result: CursorTurnResult) => void;
  let fail!: (error: unknown) => void;
  const result = new Promise<CursorTurnResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let activeRun: CursorH2Stream | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let canceled = false;
  let cancelReason: unknown;
  const stopHeartbeat = (): void => {
    if (heartbeat === undefined) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const closeRun = (reason?: unknown): void => {
    const run = activeRun;
    activeRun = undefined;
    run?.close(reason);
  };
  const handoff: ToolHandoff = {
    accumulator,
    assistantText: '',
    blobStore: input.blobStore,
    canceled: () => canceled,
    closeRun,
    fail: (error) => fail(error),
    getActiveRun: () => activeRun,
    getConversationState: () => conversationState,
    graceMs: input.timing?.toolHandoffGraceMs ?? 100,
    lastToolRevision: 0,
    settle: (turn) => settle(turn),
  };

  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      handoff.controller = controller;
      void (async () => {
        try {
          const h2 = await input.transport.openRun({
            accessToken: input.accessToken,
            ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          activeRun = h2;
          if (canceled) {
            closeRun(cancelReason);
            return;
          }
          h2.write(frameConnectMessage(input.requestBytes));
          if (input.heartbeatMs !== undefined && input.heartbeatMs > 0) {
            heartbeat = setInterval(() => h2.write(heartbeatFrame()), input.heartbeatMs);
          }
          let endStreamError: string | undefined;
          for await (const frame of h2.frames) {
            if (handoff.terminated) break;
            if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
              endStreamError = parseConnectEndStream(frame.payload).error?.message;
              continue;
            }
            const message = fromBinary(AgentServerMessageSchema, frame.payload).message;
            if (message.case === 'interactionUpdate') {
              for (const part of mapInteractionUpdate(message.value, accumulator)) enqueuePart(handoff, part);
              if (accumulator.sawTurnEnded && cursorToolState(accumulator).openCount > 0) {
                throw new Error('Cursor turn ended with incomplete MCP tool call');
              }
            } else if (message.case === 'interactionQuery') {
              h2.write(encodeInteractionReply(message.value));
            } else if (message.case === 'kvServerMessage') {
              const reply = encodeKvResponse(message.value, input.blobStore);
              if (reply !== undefined) h2.write(reply);
            } else if (message.case === 'execServerMessage') {
              if (message.value.message.case === 'mcpArgs') {
                if (message.value.message.value.smartModeApprovalOnly) {
                  h2.write(encodeMcpApprovalRejection(message.value));
                } else {
                  for (const part of mapMcpExec(message.value.message.value, accumulator)) enqueuePart(handoff, part);
                }
              } else {
                h2.write(encodeExecResponse(message.value, input.requestContextTools));
              }
            } else if (message.case === 'conversationCheckpointUpdate') {
              conversationState = message.value;
              sawCheckpoint = true;
            }
            updateHandoff(handoff);
            if (handoff.terminated) break;
          }
          if (handoff.terminated) return;
          const readyTools = cursorToolState(accumulator);
          if (readyTools.openCount === 0 && readyTools.readyCount > 0) {
            finishToolHandoff(handoff);
            return;
          }
          const trailers = await h2.trailers;
          if (endStreamError !== undefined) throw new Error(`Cursor stream error: ${endStreamError}`);
          const grpcStatus = trailers['grpc-status'];
          if (grpcStatus !== undefined && grpcStatus !== '0') {
            throw new Error(`Cursor gRPC status ${grpcStatus}: ${trailers['grpc-message'] ?? ''}`);
          }
          if (cursorToolState(accumulator).openCount > 0) {
            throw new Error('Cursor stream ended with incomplete MCP tool call');
          }
          if (!accumulator.sawTurnEnded) throw new Error('Cursor stream ended before turnEnded');
          for (const part of finalizeCursorStream(accumulator)) enqueuePart(handoff, part);
          controller.close();
          settle({
            conversationState,
            checkpointUsable: sawCheckpoint && accumulator.toolCalls === 0,
            pendingToolCalls: pendingToolCallsOf(accumulator),
            toolCalls: cursorCompletedTools(accumulator),
            assistantText: handoff.assistantText,
            blobStore: input.blobStore,
          });
        } catch (error) {
          if (handoff.terminated) return;
          closeRun(error);
          if (!canceled) controller.error(error);
          fail(error);
        } finally {
          clearHandoff(handoff);
          stopHeartbeat();
          closeRun();
        }
      })();
    },
    cancel(reason) {
      canceled = true;
      handoff.terminated = true;
      cancelReason = reason === undefined ? new Error('Cursor stream canceled') : reason;
      clearHandoff(handoff);
      stopHeartbeat();
      closeRun(cancelReason);
      fail(cancelReason);
    },
  });
  return { stream, result };
}

type ToolHandoff = {
  accumulator: CursorStreamAccumulator;
  assistantText: string;
  blobStore: Map<string, Uint8Array>;
  canceled: () => boolean;
  closeRun: (reason?: unknown) => void;
  controller?: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
  fail: (error: unknown) => void;
  getActiveRun: () => CursorH2Stream | undefined;
  getConversationState: () => ConversationStateStructure;
  graceMs: number;
  lastToolRevision: number;
  settle: (result: CursorTurnResult) => void;
  terminated?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

function enqueuePart(handoff: ToolHandoff, part: LanguageModelV4StreamPart): void {
  if (part.type === 'text-delta') handoff.assistantText += part.delta;
  handoff.controller?.enqueue(part);
}

function clearHandoff(handoff: ToolHandoff): void {
  if (handoff.timer !== undefined) clearTimeout(handoff.timer);
  handoff.timer = undefined;
}

function finishToolHandoff(handoff: ToolHandoff): void {
  if (handoff.terminated) return;
  handoff.terminated = true;
  clearHandoff(handoff);
  const calls = cursorCompletedTools(handoff.accumulator);
  for (const part of commitCursorTools(handoff.accumulator)) enqueuePart(handoff, part);
  for (const part of finalizeCursorStream(handoff.accumulator)) enqueuePart(handoff, part);
  handoff.controller?.close();
  handoff.settle({
    conversationState: handoff.getConversationState(),
    checkpointUsable: false,
    pendingToolCalls: new Map(calls.map((call) => [call.outerCallId, call.nestedToolCallId])),
    toolCalls: calls,
    assistantText: handoff.assistantText,
    blobStore: handoff.blobStore,
  });
  handoff.getActiveRun()?.end();
  handoff.closeRun();
}

function updateHandoff(handoff: ToolHandoff): void {
  const current = cursorToolState(handoff.accumulator);
  if (current.revision === handoff.lastToolRevision) return;
  handoff.lastToolRevision = current.revision;
  clearHandoff(handoff);
  if (current.openCount > 0 || current.readyCount === 0) return;
  handoff.timer = setTimeout(() => {
    handoff.timer = undefined;
    try {
      const latest = cursorToolState(handoff.accumulator);
      if (latest.openCount === 0 && latest.readyCount > 0) finishToolHandoff(handoff);
    } catch (error) {
      if (handoff.terminated) return;
      handoff.terminated = true;
      clearHandoff(handoff);
      handoff.closeRun(error);
      if (!handoff.canceled()) handoff.controller?.error(error);
      handoff.fail(error);
    }
  }, handoff.graceMs);
}

function pendingToolCallsOf(accumulator: CursorStreamAccumulator): Map<string, string> {
  return new Map(cursorCompletedTools(accumulator).map((call) => [call.outerCallId, call.nestedToolCallId]));
}

function heartbeatFrame(): Uint8Array {
  const message = create(AgentClientMessageSchema, {
    message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, message));
}
