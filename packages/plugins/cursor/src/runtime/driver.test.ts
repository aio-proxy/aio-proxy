import { expect, test } from 'bun:test';

import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { create, toBinary } from '@bufbuild/protobuf';

import { AgentServerMessageSchema, ConversationStateStructureSchema, InteractionUpdateSchema } from '../gen/agent_pb';
import type { ConnectFrame } from '../wire/frame';
import { frameConnectMessage } from '../wire/frame';
import type { CursorH2Stream, CursorTransport } from '../wire/transport';
import { runCursorTurn } from './driver';

function frameServer(value: Record<string, unknown>): Uint8Array {
  const message = create(AgentServerMessageSchema, { message: value } as never);
  return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function fakeTransport(frames: Uint8Array[]): {
  transport: CursorTransport;
  writes: Uint8Array[];
  closeReasons: unknown[];
} {
  const writes: Uint8Array[] = [];
  const closeReasons: unknown[] = [];
  const framePayloads: ConnectFrame[] = frames.map((bytes) => ({ flags: 0, payload: bytes.subarray(5) }));
  const stream: CursorH2Stream = {
    write: (frame) => writes.push(frame),
    end: () => {},
    close: (reason) => closeReasons.push(reason),
    frames: (async function* () {
      for (const frame of framePayloads) yield frame;
    })(),
    trailers: Promise.resolve({ 'grpc-status': '0' }),
  };
  return {
    writes,
    closeReasons,
    transport: {
      openRun: () => Promise.resolve(stream),
      unary: () => Promise.reject(new Error('unused')),
    },
  };
}

function openMcpTransport(frames: Uint8Array[]): {
  transport: CursorTransport;
  writes: Uint8Array[];
  endCalls: () => number;
  closeCalls: () => number;
  release: () => void;
} {
  const writes: Uint8Array[] = [];
  const ended = Promise.withResolvers<void>();
  let endCalls = 0;
  let closeCalls = 0;
  const framePayloads: ConnectFrame[] = frames.map((bytes) => ({ flags: 0, payload: bytes.subarray(5) }));
  const stream: CursorH2Stream = {
    write: (frame) => writes.push(frame),
    end: () => {
      endCalls += 1;
      ended.resolve();
    },
    close: () => {
      closeCalls += 1;
    },
    frames: (async function* () {
      for (const frame of framePayloads) yield frame;
      await ended.promise;
    })(),
    trailers: Promise.resolve({ 'grpc-status': '0' }),
  };
  return {
    writes,
    endCalls: () => endCalls,
    closeCalls: () => closeCalls,
    release: ended.resolve,
    transport: {
      openRun: () => Promise.resolve(stream),
      unary: () => Promise.reject(new Error('unused')),
    },
  };
}

function cancelableTransport(): {
  transport: CursorTransport;
  writes: Uint8Array[];
  closeReasons: unknown[];
  started: Promise<void>;
} {
  const writes: Uint8Array[] = [];
  const closeReasons: unknown[] = [];
  const started = Promise.withResolvers<void>();
  const terminal = Promise.withResolvers<void>();
  let terminalError: unknown;
  const stream: CursorH2Stream = {
    write: (frame) => {
      writes.push(frame);
      started.resolve();
    },
    end: () => {},
    close: (reason) => {
      closeReasons.push(reason);
      terminalError = reason;
      terminal.resolve();
    },
    frames: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await terminal.promise;
            if (terminalError !== undefined) throw terminalError;
            return { done: true, value: undefined };
          },
        };
      },
    },
    trailers: Promise.resolve({}),
  };
  return {
    writes,
    closeReasons,
    started: started.promise,
    transport: {
      openRun: () => Promise.resolve(stream),
      unary: () => Promise.reject(new Error('unused')),
    },
  };
}

const textFrame = (text: string) =>
  frameServer({
    case: 'interactionUpdate',
    value: create(InteractionUpdateSchema, { message: { case: 'textDelta', value: { text } } } as never),
  });
const turnEndedFrame = () =>
  frameServer({
    case: 'interactionUpdate',
    value: create(InteractionUpdateSchema, { message: { case: 'turnEnded', value: {} } } as never),
  });

async function drainTypes(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<string[]> {
  const types: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    types.push(value.type);
  }
  return types;
}

async function drainParts(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

test('a text turn streams parts, frames the request, and resolves the turn result', async () => {
  const { transport, writes, closeReasons } = fakeTransport([textFrame('Hi'), turnEndedFrame()]);
  const { stream, result } = runCursorTurn({
    transport,
    accessToken: 'tok',
    requestBytes: new Uint8Array([1]),
    initialConversationState: create(ConversationStateStructureSchema, {}),
    requestContextTools: [],
    blobStore: new Map(),
    heartbeatMs: 0,
  });
  const types = await drainTypes(stream);
  const turn = await result;
  expect(types).toContain('text-delta');
  expect(types.at(-1)).toBe('finish');
  expect(turn.checkpointUsable).toBe(true);
  expect(writes[0]?.length).toBe(6);
  expect(closeReasons).toHaveLength(1);
  expect(closeReasons).toEqual([undefined]);
});

test('rejects when the stream ends before turnEnded', async () => {
  const { transport } = fakeTransport([textFrame('Hi')]);
  const { stream, result } = runCursorTurn({
    transport,
    accessToken: 'tok',
    requestBytes: new Uint8Array([1]),
    initialConversationState: create(ConversationStateStructureSchema, {}),
    requestContextTools: [],
    blobStore: new Map(),
    heartbeatMs: 0,
  });
  // The stream errors AND `result` rejects; swallow the stream throw and assert on result.
  await drainTypes(stream).catch(() => {});
  await expect(result).rejects.toThrow(/before turnEnded/i);
});

test('a completed MCP call suspends without waiting for upstream turnEnded', async () => {
  const mcpFrame = (event: 'toolCallStarted' | 'toolCallCompleted') =>
    frameServer({
      case: 'interactionUpdate',
      value: create(InteractionUpdateSchema, {
        message: {
          case: event,
          value: {
            callId: 'outer-call',
            toolCall: {
              tool: {
                case: 'mcpToolCall',
                value: { args: { name: 'search', toolCallId: 'nested-call', args: {} } },
              },
            },
          },
        },
      } as never),
    });
  const { transport, writes, endCalls, closeCalls, release } = openMcpTransport([
    mcpFrame('toolCallStarted'),
    mcpFrame('toolCallCompleted'),
  ]);
  const { stream, result } = runCursorTurn({
    transport,
    accessToken: 'tok',
    requestBytes: new Uint8Array([1]),
    initialConversationState: create(ConversationStateStructureSchema, {}),
    requestContextTools: [],
    blobStore: new Map(),
    heartbeatMs: 0,
  });
  void result.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const parts = await Promise.race([
      drainParts(stream),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('tool stream did not suspend promptly')), 100);
      }),
    ]);
    const turn = await result;
    const toolCall = parts.find((part) => part.type === 'tool-call') as { toolCallId: string } | undefined;
    const finish = parts.at(-1) as { type: string; finishReason: { unified: string } };

    expect(toolCall?.toolCallId).toBe('outer-call');
    expect(finish).toMatchObject({ type: 'finish', finishReason: { unified: 'tool-calls' } });
    expect(endCalls()).toBe(1);
    expect(closeCalls()).toBe(1);
    expect(writes).toHaveLength(1);
    expect(turn.checkpointUsable).toBe(false);
    expect([...turn.pendingToolCalls]).toEqual([['outer-call', 'nested-call']]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    release();
  }
});

test('a turn-ended incomplete MCP call persists the mapping for every emitted tool call', async () => {
  const started = frameServer({
    case: 'interactionUpdate',
    value: create(InteractionUpdateSchema, {
      message: {
        case: 'toolCallStarted',
        value: {
          callId: 'outer-incomplete',
          toolCall: {
            tool: {
              case: 'mcpToolCall',
              value: { args: { name: 'search', toolCallId: 'nested-incomplete', args: {} } },
            },
          },
        },
      },
    } as never),
  });
  const { transport } = fakeTransport([started, turnEndedFrame()]);
  const { stream, result } = runCursorTurn({
    transport,
    accessToken: 'tok',
    requestBytes: new Uint8Array([1]),
    initialConversationState: create(ConversationStateStructureSchema, {}),
    requestContextTools: [],
    blobStore: new Map(),
    heartbeatMs: 0,
  });

  const parts = await drainParts(stream);
  const turn = await result;

  expect(parts.find((part) => part.type === 'tool-call')).toMatchObject({ toolCallId: 'outer-incomplete' });
  expect([...turn.pendingToolCalls]).toEqual([['outer-incomplete', 'nested-incomplete']]);
  expect(turn.checkpointUsable).toBe(false);
});

test('reader cancellation stops heartbeats, closes the Run, and rejects the result', async () => {
  const { transport, writes, closeReasons, started } = cancelableTransport();
  const reason = new Error('reader canceled');
  const { stream, result } = runCursorTurn({
    transport,
    accessToken: 'tok',
    requestBytes: new Uint8Array([1]),
    initialConversationState: create(ConversationStateStructureSchema, {}),
    requestContextTools: [],
    blobStore: new Map(),
    heartbeatMs: 5,
  });
  void result.catch(() => {});
  const reader = stream.getReader();

  await started;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await reader.cancel(reason);
  const writesAfterCancel = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 15));

  await expect(result).rejects.toBe(reason);
  expect(closeReasons).toEqual([reason]);
  expect(writes.length).toBe(writesAfterCancel);
});
