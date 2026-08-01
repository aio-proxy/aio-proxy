import { expect, test } from 'bun:test';

import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { CredentialPort } from '@aio-proxy/plugin-sdk';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import { AgentClientMessageSchema, AgentServerMessageSchema, InteractionUpdateSchema } from '../gen/agent_pb';
import type { CursorCredential } from '../schema';
import { CursorSessionStore } from '../store/session-store';
import type { ConnectFrame } from '../wire/frame';
import type { CursorH2Stream, CursorTransport } from '../wire/transport';
import { createCursorLanguageModel, type CursorModelRuntime } from './cursor-model';

const server = (value: Record<string, unknown>): ConnectFrame => {
  const message = create(AgentServerMessageSchema, { message: value } as never);
  return { flags: 0, payload: toBinary(AgentServerMessageSchema, message) };
};
const text = (t: string) =>
  server({
    case: 'interactionUpdate',
    value: create(InteractionUpdateSchema, { message: { case: 'textDelta', value: { text: t } } } as never),
  });
const turnEnded = () =>
  server({
    case: 'interactionUpdate',
    value: create(InteractionUpdateSchema, { message: { case: 'turnEnded', value: {} } } as never),
  });

function makeTransport(): { transport: CursorTransport; runs: Uint8Array[][] } {
  const runs: Uint8Array[][] = [];
  const transport: CursorTransport = {
    openRun: () => {
      const writes: Uint8Array[] = [];
      runs.push(writes);
      const stream: CursorH2Stream = {
        write: (frame) => writes.push(frame),
        end: () => {},
        frames: (async function* () {
          yield text('ok');
          yield turnEnded();
        })(),
        trailers: Promise.resolve({ 'grpc-status': '0' }),
      };
      return Promise.resolve(stream);
    },
    unary: () => Promise.reject(new Error('unused')),
  };
  return { transport, runs };
}

const credential: CursorCredential = {
  accessToken: 'tok',
  refreshToken: 'r',
  expiresAt: Number.MAX_SAFE_INTEGER,
  subject: 'user-1',
};
const credentials: CredentialPort<CursorCredential> = {
  read: () => Promise.resolve({ value: credential, revision: 0 }),
  refresh: () => Promise.resolve({ status: 'updated', snapshot: { value: credential, revision: 1 } }),
};

const callOptions = (): LanguageModelV4CallOptions =>
  ({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    providerOptions: {
      aioProxy: { logicalRequest: { requestId: 'r1', session: { key: 'sha256:abc', source: 'body-conversation' } } },
    },
  }) as never;

function runtimeWith(transport: CursorTransport, sessionStore: CursorSessionStore): CursorModelRuntime {
  return {
    transport,
    credentials,
    sessionStore,
    model: {
      wireModelId: 'claude-4.5-sonnet',
      displayModelId: 'claude-4.5-sonnet',
      displayName: 'Claude 4.5 Sonnet',
      maxMode: false,
    },
  };
}

async function lastPartType(stream: ReadableStream<{ type: string }>): Promise<string[]> {
  const types: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    types.push(value.type);
  }
  return types;
}

test('doStream returns a finishing stream and frames a runRequest', async () => {
  const { transport, runs } = makeTransport();
  const sessionStore = new CursorSessionStore();
  const model = createCursorLanguageModel('claude-4.5-sonnet', runtimeWith(transport, sessionStore));
  const { stream } = await model.doStream(callOptions());
  const types = await lastPartType(stream as unknown as ReadableStream<{ type: string }>);
  expect(types.at(-1)).toBe('finish');
  expect(runs[0]?.length).toBeGreaterThan(0);
  const first = fromBinary(AgentClientMessageSchema, runs[0]![0]!.subarray(5));
  expect(first.message.case).toBe('runRequest');
});

test('a second call under the same session key reuses the stored conversationId', async () => {
  const { transport, runs } = makeTransport();
  const sessionStore = new CursorSessionStore();
  const model = createCursorLanguageModel('claude-4.5-sonnet', runtimeWith(transport, sessionStore));
  const conversationIdOf = (framed: Uint8Array): string => {
    const message = fromBinary(AgentClientMessageSchema, framed.subarray(5)).message;
    if (message.case !== 'runRequest') throw new Error('expected runRequest');
    return message.value.conversationId;
  };

  const first = await model.doStream(callOptions());
  await lastPartType(first.stream as unknown as ReadableStream<{ type: string }>);
  // Persistence is fire-and-forget after the stream settles; flush the microtask.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await model.doStream(callOptions());
  await lastPartType(second.stream as unknown as ReadableStream<{ type: string }>);

  expect(conversationIdOf(runs[1]![0]!)).toBe(conversationIdOf(runs[0]![0]!));
});
