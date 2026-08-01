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

function fakeTransport(frames: Uint8Array[]): { transport: CursorTransport; writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  const framePayloads: ConnectFrame[] = frames.map((bytes) => ({ flags: 0, payload: bytes.subarray(5) }));
  const stream: CursorH2Stream = {
    write: (frame) => writes.push(frame),
    end: () => {},
    frames: (async function* () {
      for (const frame of framePayloads) yield frame;
    })(),
    trailers: Promise.resolve({ 'grpc-status': '0' }),
  };
  return {
    writes,
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

test('a text turn streams parts, frames the request, and resolves the turn result', async () => {
  const { transport, writes } = fakeTransport([textFrame('Hi'), turnEndedFrame()]);
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
