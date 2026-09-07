import { afterEach, expect, jest, test } from 'bun:test';

import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { Logger } from '@aio-proxy/plugin-sdk';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
} from '../../gen/agent_pb';
import type { ConnectFrame } from '../../wire/frame';
import { frameConnectMessage } from '../../wire/frame';
import type { CursorH2Stream, CursorTransport } from '../../wire/transport';
import { runCursorTurn } from './driver';
import { runHarness, serverFrame, settleMicrotasks, updateFrame } from './test-support';

afterEach(() => {
  jest.useRealTimers();
});

const execFrame = (id: string, query: string) =>
  serverFrame({
    case: 'execServerMessage',
    value: {
      id: id === 'a' ? 1 : 2,
      execId: 'exec-' + id,
      message: {
        case: 'mcpArgs',
        value: {
          name: 'search',
          toolName: 'search',
          toolCallId: id,
          args: { query: new TextEncoder().encode(JSON.stringify(query)) },
        },
      },
    },
  });

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
const checkpointFrame = () =>
  frameServer({
    case: 'conversationCheckpointUpdate',
    value: create(ConversationStateStructureSchema, {}),
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
  const { transport, writes, closeReasons } = fakeTransport([textFrame('Hi'), checkpointFrame(), turnEndedFrame()]);
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
  expect(turn.assistantText).toBe('Hi');
  expect(turn.toolCalls).toEqual([]);
  expect(turn.checkpointUsable).toBe(true);
  expect(writes[0]?.length).toBe(6);
  expect(closeReasons).toHaveLength(1);
  expect(closeReasons).toEqual([undefined]);
});

test('a text turn without a received checkpoint does not mark the initial state reusable', async () => {
  const { transport } = fakeTransport([textFrame('Hi'), turnEndedFrame()]);
  const { stream, result } = runCursorTurn({
    transport,
    accessToken: 'tok',
    requestBytes: new Uint8Array([1]),
    initialConversationState: create(ConversationStateStructureSchema, {}),
    requestContextTools: [],
    blobStore: new Map(),
    heartbeatMs: 0,
  });

  await drainTypes(stream);
  expect((await result).checkpointUsable).toBe(false);
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
  void result.catch(() => {});
  await expect(drainTypes(stream)).rejects.toMatchObject({ code: 'cursor_stream_incomplete' });
  await expect(result).rejects.toMatchObject({ code: 'cursor_stream_incomplete' });
});

test('a non-zero grpc trailer fails the turn on stream and result', async () => {
  const h = runHarness();
  h.send(updateFrame({ case: 'textDelta', value: { text: 'OK' } }));
  h.send(updateFrame({ case: 'turnEnded', value: {} }));
  h.eof({ 'grpc-status': '13', 'grpc-message': 'boom' });
  await expect(h.drained).rejects.toThrow(/gRPC status 13/);
  await expect(h.result).rejects.toThrow(/gRPC status 13/);
  expect(h.closeCount()).toBe(1);
});

test('a completed MCP call suspends without waiting for upstream turnEnded', async () => {
  jest.useFakeTimers();
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
                value: {
                  args: {
                    name: 'search',
                    toolCallId: 'nested-call',
                    args: event === 'toolCallCompleted' ? { query: new TextEncoder().encode('"docs"') } : {},
                  },
                },
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
  try {
    const drain = drainParts(stream);
    await settleMicrotasks();
    jest.advanceTimersByTime(100);
    const parts = await drain;
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
    expect(turn.toolCalls).toHaveLength(1);
  } finally {
    release();
  }
});

test('an mcpArgs exec suspends instead of acknowledging the caller tool', async () => {
  const exec = frameServer({
    case: 'execServerMessage',
    value: create(ExecServerMessageSchema, {
      id: 7,
      execId: 'exec-7',
      message: {
        case: 'mcpArgs',
        value: create(McpArgsSchema, {
          name: 'search',
          toolCallId: 'nested-call',
          args: { query: new TextEncoder().encode('"docs"') },
        }),
      },
    }),
  });
  const { transport, writes } = fakeTransport([exec]);
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

  expect(parts.find((part) => part.type === 'tool-call')).toMatchObject({
    toolCallId: 'nested-call',
    toolName: 'search',
    input: '{"query":"docs"}',
  });
  expect(
    parts
      .filter((part) => part.type === 'tool-input-delta' && part.id === 'nested-call')
      .map((part) => (part as { delta: string }).delta)
      .join(''),
  ).toBe('{"query":"docs"}');
  expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'tool-calls' } });
  expect(writes).toHaveLength(1);
  expect([...turn.pendingToolCalls]).toEqual([['nested-call', 'nested-call']]);
});

test.each([
  ['turn-ended', true],
  ['EOF', false],
] as const)('%s rejects incomplete MCP calls', async (_boundary, includeTurnEnded) => {
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
  const { transport } = fakeTransport([started, ...(includeTurnEnded ? [turnEndedFrame()] : [])]);
  const { stream, result } = runCursorTurn({
    transport,
    accessToken: 'tok',
    requestBytes: new Uint8Array([1]),
    initialConversationState: create(ConversationStateStructureSchema, {}),
    requestContextTools: [],
    blobStore: new Map(),
    heartbeatMs: 0,
  });

  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  void result.catch(() => {});
  const drain = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parts.push(value);
    }
  };

  await expect(drain()).rejects.toMatchObject({ code: 'cursor_tool_input_incomplete' });
  await expect(result).rejects.toMatchObject({ code: 'cursor_tool_input_incomplete' });
  expect(parts.some((part) => part.type === 'tool-call')).toBe(false);
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

test('replies to a hosted search query with its original id', async () => {
  const h = runHarness();
  h.send(
    serverFrame({
      case: 'interactionQuery',
      value: {
        id: 41,
        query: { case: 'webSearchRequestQuery', value: {} },
      },
    }),
  );
  await settleMicrotasks();
  expect(h.writes).toContainEqual(
    expect.objectContaining({
      case: 'interactionResponse',
      value: expect.objectContaining({
        id: 41,
        result: expect.objectContaining({ case: 'webSearchRequestResponse' }),
      }),
    }),
  );
  h.send(updateFrame({ case: 'turnEnded', value: {} }));
  h.eof();
  await h.drained;
  await h.result;
});

test('an approval-only wire frame never becomes an executable call', async () => {
  const base = toBinary(
    McpArgsSchema,
    create(McpArgsSchema, {
      name: 'search',
      toolName: 'search',
      toolCallId: 'probe',
      args: { query: new TextEncoder().encode('"docs"') },
    }),
  );
  const bytes = new Uint8Array([...base, 0x38, 0x01]);
  const h = runHarness();
  h.send(
    serverFrame({
      case: 'execServerMessage',
      value: {
        id: 7,
        execId: 'exec-7',
        message: { case: 'mcpArgs', value: fromBinary(McpArgsSchema, bytes) },
      },
    }),
  );
  await settleMicrotasks();
  expect(h.parts.some((part) => part.type.startsWith('tool-'))).toBe(false);
  expect(h.writes).toContainEqual(
    expect.objectContaining({
      case: 'execClientMessage',
      value: expect.objectContaining({
        id: 7,
        execId: 'exec-7',
        message: expect.objectContaining({
          case: 'mcpResult',
          value: expect.objectContaining({ result: expect.objectContaining({ case: 'rejected' }) }),
        }),
      }),
    }),
  );
  h.send(
    serverFrame({
      case: 'execServerMessage',
      value: {
        id: 7,
        execId: 'exec-7',
        message: { case: 'mcpArgs', value: fromBinary(McpArgsSchema, base) },
      },
    }),
  );
  h.send(updateFrame({ case: 'turnEnded', value: {} }));
  h.eof();
  await h.drained;
  await h.result;
  expect(h.parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
});

test('an embedded approval-only interaction frame never becomes an executable call', async () => {
  const probe = create(McpArgsSchema, {
    name: 'search',
    toolName: 'search',
    toolCallId: 'probe',
    args: { query: new TextEncoder().encode('"docs"') },
    smartModeApprovalOnly: true,
  });
  const real = create(McpArgsSchema, {
    name: 'search',
    toolName: 'search',
    toolCallId: 'probe',
    args: { query: new TextEncoder().encode('"docs"') },
  });
  const display = (args: typeof probe) => ({
    callId: 'outer-7',
    toolCall: { tool: { case: 'mcpToolCall', value: { args } } },
  });
  const h = runHarness();
  h.send(updateFrame({ case: 'toolCallStarted', value: display(probe) }));
  h.send(updateFrame({ case: 'toolCallCompleted', value: display(probe) }));
  await settleMicrotasks();
  expect(h.parts.some((part) => part.type.startsWith('tool-'))).toBe(false);
  h.send(updateFrame({ case: 'toolCallStarted', value: display(real) }));
  h.send(updateFrame({ case: 'toolCallCompleted', value: display(real) }));
  h.send(updateFrame({ case: 'turnEnded', value: {} }));
  h.eof();
  await h.drained;
  await h.result;
  expect(h.parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
});

test('unknown queries fail instead of leaving upstream waiting', async () => {
  const h = runHarness();
  h.send(serverFrame({ case: 'interactionQuery', value: { id: 9 } }));
  await expect(h.result).rejects.toMatchObject({ code: 'cursor_interaction_unsupported' });
  expect(h.closeCount()).toBe(1);
});

test('a late sibling revokes tool handoff until its own args are ready', async () => {
  jest.useFakeTimers();
  const h = runHarness({ timing: { toolHandoffGraceMs: 100 } });
  h.send(execFrame('a', 'alpha'));
  await settleMicrotasks();
  jest.advanceTimersByTime(90);
  h.send(
    updateFrame({
      case: 'toolCallStarted',
      value: {
        callId: 'outer-b',
        toolCall: {
          tool: {
            case: 'mcpToolCall',
            value: {
              args: { name: 'search', toolName: 'search', toolCallId: 'b', args: {} },
            },
          },
        },
      },
    }),
  );
  await settleMicrotasks();
  jest.advanceTimersByTime(20);
  await settleMicrotasks();
  expect(h.parts.some((p) => p.type === 'tool-call')).toBe(false);
  h.send(execFrame('b', 'beta'));
  await settleMicrotasks();
  jest.advanceTimersByTime(100);
  await h.drained;
  const calls = h.parts.filter((p) => p.type === 'tool-call');
  expect(calls).toMatchObject([
    { toolCallId: 'a', input: '{"query":"alpha"}' },
    { toolCallId: 'outer-b', input: '{"query":"beta"}' },
  ]);
  expect(h.parts.filter((p) => p.type === 'finish')).toHaveLength(1);
  expect(h.writes.filter((m) => m.case === 'execClientMessage')).toHaveLength(0);
  expect((await h.result).toolCalls).toHaveLength(2);
});

test('consecutive MCP execs are handed off together', async () => {
  jest.useFakeTimers();
  const h = runHarness();
  h.send(execFrame('a', 'alpha'));
  h.send(execFrame('b', 'beta'));
  await settleMicrotasks();
  jest.advanceTimersByTime(100);
  await h.drained;
  expect(h.parts.filter((p) => p.type === 'tool-call')).toMatchObject([
    { toolCallId: 'a', input: '{"query":"alpha"}' },
    { toolCallId: 'b', input: '{"query":"beta"}' },
  ]);
  const toolParts = h.parts.filter((p) => p.type.startsWith('tool-'));
  expect(toolParts).toMatchObject([
    { type: 'tool-input-start', id: 'a', toolName: 'search' },
    { type: 'tool-input-delta', id: 'a', delta: '{"query":"alpha"}' },
    { type: 'tool-input-end', id: 'a' },
    { type: 'tool-call', toolCallId: 'a', input: '{"query":"alpha"}' },
    { type: 'tool-input-start', id: 'b', toolName: 'search' },
    { type: 'tool-input-delta', id: 'b', delta: '{"query":"beta"}' },
    { type: 'tool-input-end', id: 'b' },
    { type: 'tool-call', toolCallId: 'b', input: '{"query":"beta"}' },
  ]);
  expect(toolParts.filter((p) => p.type === 'tool-input-delta')).toHaveLength(2);
});

test('duplicate exec does not extend the original handoff deadline', async () => {
  jest.useFakeTimers();
  const h = runHarness();
  h.send(execFrame('a', 'alpha'));
  await settleMicrotasks();
  jest.advanceTimersByTime(90);
  h.send(execFrame('a', 'alpha'));
  await settleMicrotasks();
  jest.advanceTimersByTime(10);
  await h.drained;
  expect(h.parts.filter((p) => p.type === 'tool-call')).toHaveLength(1);
});

test('successful Connect END_STREAM finishes before HTTP EOF', async () => {
  const h = runHarness();
  h.send(updateFrame({ case: 'textDelta', value: { text: 'OK' } }));
  h.send(updateFrame({ case: 'turnEnded', value: {} }));
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await h.drained; // 故意不调用 eof()
  await h.result;
  expect(h.parts.filter((p) => p.type === 'finish')).toHaveLength(1);
  expect(h.closeCount()).toBe(1);
});

test('an error envelope wins over a pending tool handoff', async () => {
  jest.useFakeTimers();
  const h = runHarness();
  h.send(execFrame('a', 'docs'));
  await settleMicrotasks();
  h.send({ flags: 2, payload: new TextEncoder().encode('{"error":{"code":"internal","message":"upstream failed"}}') });
  await expect(h.result).rejects.toThrow('upstream failed');
  jest.advanceTimersByTime(1000);
  expect(h.parts.some((p) => p.type === 'finish')).toBe(false);
  expect(h.closeCount()).toBe(1);
});

test('turnEnded grace closes a held-open text run once', async () => {
  jest.useFakeTimers();
  const h = runHarness({ timing: { turnEndGraceMs: 500 } });
  h.send(updateFrame({ case: 'textDelta', value: { text: 'OK' } }));
  h.send(updateFrame({ case: 'turnEnded', value: {} }));
  await settleMicrotasks();
  jest.advanceTimersByTime(499);
  await settleMicrotasks();
  expect(h.parts.some((p) => p.type === 'finish')).toBe(false);
  jest.advanceTimersByTime(1);
  await h.drained;
  expect(h.parts.filter((p) => p.type === 'finish')).toHaveLength(1);
  h.fail(new Error('late socket close'));
  await expect(h.result).resolves.toBeDefined();
});

test('a pending MCP input fails on successful protocol end', async () => {
  const h = runHarness();
  h.send(
    updateFrame({
      case: 'toolCallStarted',
      value: {
        callId: 'outer',
        toolCall: {
          tool: {
            case: 'mcpToolCall',
            value: {
              args: { name: 'search', toolName: 'search', toolCallId: 'nested', args: {} },
            },
          },
        },
      },
    }),
  );
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await expect(h.result).rejects.toMatchObject({ code: 'cursor_tool_input_incomplete' });
  await expect(h.drained).rejects.toMatchObject({ code: 'cursor_tool_input_incomplete' });
  expect(h.parts.some((p) => p.type === 'tool-call')).toBe(false);
});

test('heartbeats prevent silence timeout but cannot prevent no-progress timeout', async () => {
  jest.useFakeTimers();
  const h = runHarness({
    timing: {
      firstFrameTimeoutMs: 20,
      frameSilenceTimeoutMs: 30,
      noProgressTimeoutMs: 80,
    },
  });
  h.send(updateFrame({ case: 'heartbeat', value: {} }));
  await settleMicrotasks();
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(25);
    h.send(updateFrame({ case: 'heartbeat', value: {} }));
    await settleMicrotasks();
  }
  jest.advanceTimersByTime(5);
  await expect(h.result).rejects.toMatchObject({ code: 'cursor_no_progress_timeout' });
  const writes = h.writes.length;
  jest.advanceTimersByTime(300000);
  expect(h.writes).toHaveLength(writes);
  expect(h.closeCount()).toBe(1);
});

test('silence and first-frame waits have distinct errors', async () => {
  jest.useFakeTimers();
  const a = runHarness({ timing: { firstFrameTimeoutMs: 20 } });
  jest.advanceTimersByTime(20);
  await expect(a.result).rejects.toMatchObject({ code: 'cursor_first_frame_timeout' });
  const b = runHarness({ timing: { frameSilenceTimeoutMs: 30, noProgressTimeoutMs: 80 } });
  b.send(updateFrame({ case: 'textDelta', value: { text: 'progress' } }));
  await settleMicrotasks();
  jest.advanceTimersByTime(30);
  await expect(b.result).rejects.toMatchObject({ code: 'cursor_frame_silence_timeout' });
});

test('cancel before protocol success preserves the cancellation reason', async () => {
  const h = runHarness();
  await settleMicrotasks();
  const reason = new Error('user canceled');
  await h.cancel(reason);
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await expect(h.result).rejects.toBe(reason);
  expect(h.parts.some((p) => p.type === 'finish')).toBe(false);
  expect(h.closeCount()).toBe(1);
});

test('an abort after protocol success cannot replace success', async () => {
  const signal = new AbortController();
  const h = runHarness({ signal: signal.signal });
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await h.drained;
  signal.abort(new Error('late cancel'));
  await expect(h.result).resolves.toBeDefined();
  expect(h.closeCount()).toBe(1);
});

test('a late openRun handle is closed without writing after cancellation', async () => {
  const gate = Promise.withResolvers<void>();
  const h = runHarness({}, gate.promise);
  const reason = new Error('cancel before open');
  await h.cancel(reason);
  await expect(h.result).rejects.toBe(reason);
  gate.resolve();
  await settleMicrotasks();
  expect(h.closeCount()).toBe(1);
  expect(h.writes).toHaveLength(0);
});

test('run diagnostics correlate phases without logging request content', async () => {
  const rows: unknown[] = [];
  const sink: Logger['debug'] = (a, b) => {
    rows.push([a, b]);
  };
  const logger: Logger = { debug: sink, info: sink, warn: sink, error: sink, child: () => logger };
  const h = runHarness({
    logger,
    accessToken: 'SECRET_ACCESS_TOKEN',
    diagnosticsContext: {
      requestId: 'req-123',
      providerId: 'cursor-1',
      modelId: 'composer-2',
      resumeMode: 'fresh',
    },
  });
  h.send(updateFrame({ case: 'textDelta', value: { text: 'SECRET_MODEL_TEXT' } }));
  h.send(execFrame('a', 'SECRET_TOOL_ARGS'));
  h.send(
    serverFrame({
      case: 'interactionQuery',
      value: {
        id: 52,
        query: {
          case: 'webSearchRequestQuery',
          value: { args: { searchTerm: 'https://secret.example/path/to/file' } },
        },
      },
    }),
  );
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await h.drained;
  await h.result;
  const serialized = JSON.stringify(rows);
  expect(serialized).toContain('req-123');
  expect(serialized).toContain('cursor-1');
  expect(serialized).toContain('first-frame');
  expect(serialized).toContain('first-text');
  expect(serialized).toContain('query-reply');
  expect(serialized).toContain('settled');
  expect(serialized).not.toContain('SECRET_ACCESS_TOKEN');
  expect(serialized).not.toContain('SECRET_MODEL_TEXT');
  expect(serialized).not.toContain('SECRET_TOOL_ARGS');
  expect(serialized).not.toContain('https://secret.example/path/to/file');
  const emailRows: unknown[] = [];
  const emailSink: Logger['debug'] = (a, b) => {
    emailRows.push([a, b]);
  };
  const emailLogger: Logger = {
    debug: emailSink,
    info: emailSink,
    warn: emailSink,
    error: emailSink,
    child: () => emailLogger,
  };
  const emailRun = runHarness({
    logger: emailLogger,
    diagnosticsContext: {
      requestId: 'req-456',
      providerId: 'user@example.com',
      modelId: 'composer-2',
      resumeMode: 'fresh',
    },
  });
  emailRun.send(updateFrame({ case: 'textDelta', value: { text: 'OK' } }));
  emailRun.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await emailRun.drained;
  await emailRun.result;
  expect(JSON.stringify(emailRows)).not.toContain('user@example.com');
});

test('a throwing log sink cannot change the successful stream', async () => {
  const sink: Logger['debug'] = () => {
    throw new Error('broken sink');
  };
  const logger: Logger = { debug: sink, info: sink, warn: sink, error: sink, child: () => logger };
  const h = runHarness({ logger });
  h.send(updateFrame({ case: 'textDelta', value: { text: 'OK' } }));
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await h.drained;
  await expect(h.result).resolves.toBeDefined();
  expect(h.parts.filter((p) => p.type === 'finish')).toHaveLength(1);
});
