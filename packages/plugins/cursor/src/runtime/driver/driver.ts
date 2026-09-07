import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { Logger } from '@aio-proxy/plugin-sdk';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ClientHeartbeatSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type InteractionUpdate,
  type McpToolDefinition,
} from '../../gen/agent_pb';
import type { ConnectFrame } from '../../wire/frame';
import { CONNECT_END_STREAM_FLAG, frameConnectMessage, parseConnectEndStream } from '../../wire/frame';
import type { CursorH2Stream, CursorTransport } from '../../wire/transport';
import { encodeExecResponse, encodeKvResponse, encodeMcpApprovalRejection } from '../client-messages';
import { encodeInteractionReply } from '../interaction-query';
import type { CursorCompletedToolCall } from '../mcp-call';
import { CursorProtocolError } from '../protocol-error';
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
import { createRunDiagnostics } from './diagnostics';
import { createRunLifecycle } from './lifecycle';

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

type CursorRunInput = Parameters<typeof runCursorTurn>[0];
type RunLifecycle = ReturnType<typeof createRunLifecycle>;
type StreamController = ReadableStreamDefaultController<LanguageModelV4StreamPart>;

type CursorRunSession = {
  accumulator: CursorStreamAccumulator;
  activeRun: CursorH2Stream | undefined;
  assistantText: string;
  abortListener: (() => void) | undefined;
  canceled: boolean;
  conversationState: ConversationStateStructure;
  diagnostics: ReturnType<typeof createRunDiagnostics>;
  handoffTimer: ReturnType<typeof setTimeout> | undefined;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  input: CursorRunInput;
  internalAbort: AbortController;
  lastToolRevision: number;
  lifecycle: RunLifecycle;
  logged: { firstFrame: boolean; firstText: boolean; turnEnded: boolean };
  rejectResult: (error: unknown) => void;
  sawCheckpoint: boolean;
  settleResult: (result: CursorTurnResult) => void;
  timing: CursorRunTiming;
};

const DEFAULT_TIMING: CursorRunTiming = {
  firstFrameTimeoutMs: 120_000,
  frameSilenceTimeoutMs: 120_000,
  noProgressTimeoutMs: 240_000,
  toolHandoffGraceMs: 100,
  turnEndGraceMs: 500,
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
  readonly logger?: Logger;
  readonly diagnosticsContext?: {
    requestId: string;
    providerId?: string;
    modelId: string;
    resumeMode: 'fresh' | 'checkpoint' | 'tool-results';
  };
}): { stream: ReadableStream<LanguageModelV4StreamPart>; result: Promise<CursorTurnResult> } {
  let resultLocked = false;
  let settleResult!: (result: CursorTurnResult) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<CursorTurnResult>((resolve, reject) => {
    settleResult = (turn) => {
      if (resultLocked) return;
      resultLocked = true;
      resolve(turn);
    };
    rejectResult = (error) => {
      if (resultLocked) return;
      resultLocked = true;
      reject(error);
    };
  });
  const session: CursorRunSession = {
    accumulator: createCursorStreamAccumulator(input.requestContextTools),
    activeRun: undefined,
    assistantText: '',
    abortListener: undefined,
    canceled: false,
    conversationState: input.initialConversationState,
    diagnostics: createRunDiagnostics(
      input.logger,
      input.diagnosticsContext ?? { requestId: crypto.randomUUID(), modelId: 'unknown', resumeMode: 'fresh' },
    ),
    handoffTimer: undefined,
    heartbeat: undefined,
    input,
    internalAbort: new AbortController(),
    lastToolRevision: 0,
    lifecycle: undefined as unknown as RunLifecycle,
    logged: { firstFrame: false, firstText: false, turnEnded: false },
    rejectResult,
    sawCheckpoint: false,
    settleResult,
    timing: { ...DEFAULT_TIMING, ...input.timing },
  };
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      bindRunLifecycle(session, controller);
      listenForExternalAbort(session);
      void pumpCursorRun(session, controller);
    },
    cancel(reason) {
      session.canceled = true;
      session.lifecycle.fail(reason === undefined ? new Error('Cursor stream canceled') : reason);
    },
  });
  return { stream, result };
}

function bindRunLifecycle(session: CursorRunSession, controller: StreamController): void {
  session.lifecycle = createRunLifecycle({
    limits: {
      firstFrameTimeoutMs: session.timing.firstFrameTimeoutMs,
      frameSilenceTimeoutMs: session.timing.frameSilenceTimeoutMs,
      noProgressTimeoutMs: session.timing.noProgressTimeoutMs,
      turnEndGraceMs: session.timing.turnEndGraceMs,
    },
    onFinish: (reason) => finishCursorTurn(session, controller, reason),
    onFailure(error) {
      const canceled = session.canceled || session.input.signal?.aborted;
      logSettled(
        session,
        canceled ? 'canceled' : error instanceof CursorProtocolError ? error.code : 'transport-error',
        !canceled,
      );
      safeCall(() => !session.canceled && controller.error(error));
      session.rejectResult(error);
    },
    cleanup(error) {
      clearHandoff(session);
      stopHeartbeat(session);
      const signal = session.input.signal;
      if (signal !== undefined && session.abortListener !== undefined) {
        signal.removeEventListener('abort', session.abortListener);
        session.abortListener = undefined;
      }
      closeRun(session, error);
      if (!session.internalAbort.signal.aborted) {
        safeCall(() => session.internalAbort.abort(error));
      }
    },
  });
}

function listenForExternalAbort(session: CursorRunSession): void {
  const signal = session.input.signal;
  session.abortListener = () => session.lifecycle.fail(signal?.reason ?? new Error('Cursor stream canceled'));
  if (signal === undefined) return;
  if (signal.aborted) session.abortListener();
  else signal.addEventListener('abort', session.abortListener);
}

async function pumpCursorRun(session: CursorRunSession, controller: StreamController): Promise<void> {
  session.diagnostics('run-start', session.lifecycle.snapshot());
  try {
    const h2 = await openCursorRun(session);
    if (h2 === undefined) return;
    for await (const frame of h2.frames) {
      if (session.lifecycle.settled()) break;
      if (handleConnectEnd(session, frame)) return;
      dispatchServerMessage(session, controller, h2, fromBinary(AgentServerMessageSchema, frame.payload).message);
      if (session.lifecycle.settled()) break;
    }
    if (session.lifecycle.settled()) return;
    session.diagnostics('http-eof', session.lifecycle.snapshot());
    settleHttpEof(session, await h2.trailers);
  } catch (error) {
    if (session.lifecycle.settled()) return;
    session.lifecycle.fail(error);
  }
}

async function openCursorRun(session: CursorRunSession): Promise<CursorH2Stream | undefined> {
  const input = session.input;
  const signal =
    input.signal === undefined
      ? session.internalAbort.signal
      : AbortSignal.any([session.internalAbort.signal, input.signal]);
  const h2 = await input.transport.openRun({
    accessToken: input.accessToken,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    signal,
  });
  if (session.lifecycle.settled()) {
    safeCall(() => h2.close());
    return undefined;
  }
  session.activeRun = h2;
  h2.write(frameConnectMessage(input.requestBytes));
  startHeartbeat(session, h2);
  return h2;
}

function handleConnectEnd(session: CursorRunSession, frame: ConnectFrame): boolean {
  if ((frame.flags & CONNECT_END_STREAM_FLAG) === 0) return false;
  const envelope = parseConnectEndStream(frame.payload);
  session.diagnostics('connect-end', session.lifecycle.snapshot());
  if (envelope.error !== undefined) session.lifecycle.fail(new Error(envelope.error.message));
  else session.lifecycle.finish('connect-end');
  return true;
}

function settleHttpEof(session: CursorRunSession, trailers: Record<string, string>): void {
  const grpcStatus = trailers['grpc-status'];
  if (grpcStatus !== undefined && grpcStatus !== '0') {
    session.lifecycle.fail(new Error(`Cursor gRPC status ${grpcStatus}: ${trailers['grpc-message'] ?? ''}`));
    return;
  }
  const tools = cursorToolState(session.accumulator);
  if (tools.openCount > 0) {
    session.lifecycle.fail(
      new CursorProtocolError('cursor_tool_input_incomplete', 'Cursor ended with incomplete MCP input.'),
    );
    return;
  }
  if (tools.readyCount > 0) {
    session.lifecycle.finish('tool-handoff');
    return;
  }
  if (session.accumulator.sawTurnEnded) {
    session.lifecycle.finish('turn-ended');
    return;
  }
  session.lifecycle.fail(new CursorProtocolError('cursor_stream_incomplete', 'Cursor stream ended before turnEnded'));
}

function dispatchServerMessage(
  session: CursorRunSession,
  controller: StreamController,
  h2: CursorH2Stream,
  message: AgentServerMessage['message'],
): void {
  if (message.case === 'interactionUpdate') {
    handleInteractionUpdate(session, controller, message.value);
    return;
  }
  if (message.case === 'interactionQuery') {
    h2.write(encodeInteractionReply(message.value));
    session.diagnostics('query-reply', { queryCase: message.value.query.case, queryId: message.value.id });
    noteDecodedFrame(session, true);
    return;
  }
  if (message.case === 'kvServerMessage') {
    const reply = encodeKvResponse(message.value, session.input.blobStore);
    if (reply !== undefined) h2.write(reply);
    noteDecodedFrame(session, reply !== undefined);
    return;
  }
  if (message.case === 'execServerMessage') {
    handleExecMessage(session, controller, h2, message.value);
    return;
  }
  if (message.case === 'conversationCheckpointUpdate') {
    session.conversationState = message.value;
    session.sawCheckpoint = true;
  }
  noteDecodedFrame(session, false);
}

function handleInteractionUpdate(
  session: CursorRunSession,
  controller: StreamController,
  update: InteractionUpdate,
): void {
  const before = cursorToolState(session.accumulator);
  for (const part of mapInteractionUpdate(update, session.accumulator)) enqueuePart(session, controller, part);
  if (
    !session.logged.firstText &&
    update.message.case === 'textDelta' &&
    (update.message.value.text?.length ?? 0) > 0
  ) {
    session.logged.firstText = true;
    session.diagnostics('first-text', session.lifecycle.snapshot());
  }
  logToolReadyIfIncreased(session, before.readyCount);
  noteDecodedFrame(session, isInteractionProgress(update, before.progressRevision, session.accumulator));
  if (session.accumulator.sawTurnEnded) {
    if (!session.logged.turnEnded) {
      session.logged.turnEnded = true;
      session.diagnostics('turn-ended', session.lifecycle.snapshot());
    }
    clearHandoff(session);
    session.lifecycle.turnEnded();
    return;
  }
  armHandoff(session);
}

function handleExecMessage(
  session: CursorRunSession,
  controller: StreamController,
  h2: CursorH2Stream,
  exec: ExecServerMessage,
): void {
  if (exec.message.case === 'mcpArgs') {
    if (exec.message.value.smartModeApprovalOnly) {
      h2.write(encodeMcpApprovalRejection(exec));
      noteDecodedFrame(session, true);
      return;
    }
    const before = cursorToolState(session.accumulator);
    for (const part of mapMcpExec(exec.message.value, session.accumulator)) enqueuePart(session, controller, part);
    logToolReadyIfIncreased(session, before.readyCount);
    noteDecodedFrame(session, cursorToolState(session.accumulator).progressRevision > before.progressRevision);
    armHandoff(session);
    return;
  }
  h2.write(encodeExecResponse(exec, session.input.requestContextTools));
  noteDecodedFrame(session, true);
}

function finishCursorTurn(
  session: CursorRunSession,
  controller: StreamController,
  reason: 'tool-handoff' | 'turn-ended' | 'connect-end',
): void {
  const current = cursorToolState(session.accumulator);
  if (current.openCount > 0) {
    throw new CursorProtocolError('cursor_tool_input_incomplete', 'Cursor ended with incomplete MCP input.');
  }
  if (current.readyCount > 0) {
    session.diagnostics('tool-handoff', { openToolCount: current.openCount, readyToolCount: current.readyCount });
  }
  const calls = cursorCompletedTools(session.accumulator);
  for (const part of commitCursorTools(session.accumulator)) enqueuePart(session, controller, part);
  for (const part of finalizeCursorStream(session.accumulator)) enqueuePart(session, controller, part);
  controller.close();
  session.settleResult({
    conversationState: session.conversationState,
    checkpointUsable: session.sawCheckpoint && calls.length === 0,
    pendingToolCalls: new Map(calls.map((call) => [call.outerCallId, call.nestedToolCallId])),
    toolCalls: calls,
    assistantText: session.assistantText,
    blobStore: session.input.blobStore,
  });
  logSettled(session, reason, false, current);
  try {
    session.activeRun?.end();
  } catch {
    /* success is already committed */
  }
}

function armHandoff(session: CursorRunSession): void {
  if (session.accumulator.sawTurnEnded || session.lifecycle.settled()) return;
  const current = cursorToolState(session.accumulator);
  if (current.revision === session.lastToolRevision) return;
  session.lastToolRevision = current.revision;
  clearHandoff(session);
  if (current.openCount > 0 || current.readyCount === 0) return;
  session.handoffTimer = setTimeout(() => {
    session.handoffTimer = undefined;
    session.lifecycle.finish('tool-handoff');
  }, session.timing.toolHandoffGraceMs);
}

function startHeartbeat(session: CursorRunSession, h2: CursorH2Stream): void {
  const heartbeatMs = session.input.heartbeatMs;
  if (heartbeatMs === undefined || heartbeatMs <= 0) return;
  session.heartbeat = setInterval(() => {
    try {
      h2.write(heartbeatFrame());
    } catch (error) {
      session.lifecycle.fail(error);
    }
  }, heartbeatMs);
}

function stopHeartbeat(session: CursorRunSession): void {
  if (session.heartbeat === undefined) return;
  clearInterval(session.heartbeat);
  session.heartbeat = undefined;
}

function clearHandoff(session: CursorRunSession): void {
  if (session.handoffTimer === undefined) return;
  clearTimeout(session.handoffTimer);
  session.handoffTimer = undefined;
}

function closeRun(session: CursorRunSession, reason?: unknown): void {
  const run = session.activeRun;
  session.activeRun = undefined;
  try {
    run?.close(reason);
  } catch {
    /* cleanup must not throw */
  }
}

function enqueuePart(session: CursorRunSession, controller: StreamController, part: LanguageModelV4StreamPart): void {
  if (part.type === 'text-delta') session.assistantText += part.delta;
  controller.enqueue(part);
}

function isInteractionProgress(
  update: InteractionUpdate,
  beforeRevision: number,
  accumulator: CursorStreamAccumulator,
): boolean {
  const message = update.message;
  if (message.case === 'textDelta') return (message.value.text?.length ?? 0) > 0;
  if (message.case === 'thinkingDelta') return (message.value.text?.length ?? 0) > 0;
  if (message.case === 'tokenDelta') return (message.value.tokens ?? 0) > 0;
  return cursorToolState(accumulator).progressRevision > beforeRevision;
}

function heartbeatFrame(): Uint8Array {
  const message = create(AgentClientMessageSchema, {
    message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, message));
}

function noteDecodedFrame(session: CursorRunSession, progress: boolean): void {
  session.lifecycle.noteFrame(progress);
  if (session.logged.firstFrame) return;
  session.logged.firstFrame = true;
  session.diagnostics('first-frame', session.lifecycle.snapshot());
}

function logToolReadyIfIncreased(session: CursorRunSession, beforeReady: number): void {
  const tools = cursorToolState(session.accumulator);
  if (tools.readyCount <= beforeReady) return;
  session.diagnostics('tool-ready', {
    ...session.lifecycle.snapshot(),
    openToolCount: tools.openCount,
    readyToolCount: tools.readyCount,
  });
}

function logSettled(
  session: CursorRunSession,
  termination: string,
  failed: boolean,
  tools = cursorToolState(session.accumulator),
): void {
  session.diagnostics(
    'settled',
    { termination, ...session.lifecycle.snapshot(), openToolCount: tools.openCount, readyToolCount: tools.readyCount },
    failed,
  );
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    /* terminal callbacks must not throw */
  }
}
