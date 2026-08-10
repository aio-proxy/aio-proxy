import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';

import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { CredentialPort } from '@aio-proxy/plugin-sdk';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  ToolCallSchema,
  UserMessageSchema,
} from '../gen/agent_pb';
import type { CursorCredential } from '../schema';
import { storeCursorBlob } from '../store/blobs';
import { CursorSessionStore, sessionKey } from '../store/session-store';
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

const logicalStoreKey = sessionKey({ identityScope: 'user-1', logicalSessionKey: 'sha256:abc' });

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

test('a tool-result-only continuation restores structured MCP history with the nested ID', async () => {
  const { transport, runs } = makeTransport();
  const sessionStore = new CursorSessionStore();
  const blobs = new Map<string, Uint8Array>();
  const userMessage = storeCursorBlob(
    blobs,
    toBinary(UserMessageSchema, create(UserMessageSchema, { text: 'search the docs' })),
  );
  const mcpStep = storeCursorBlob(
    blobs,
    toBinary(
      ConversationStepSchema,
      create(ConversationStepSchema, {
        message: {
          case: 'toolCall',
          value: create(ToolCallSchema, {
            tool: {
              case: 'mcpToolCall',
              value: create(McpToolCallSchema, {
                args: create(McpArgsSchema, { name: 'search', toolCallId: 'nested-call' }),
              }),
            },
          }),
        },
      }),
    ),
  );
  const checkpointTurn = storeCursorBlob(
    blobs,
    toBinary(
      ConversationTurnStructureSchema,
      create(ConversationTurnStructureSchema, {
        turn: {
          case: 'agentConversationTurn',
          value: create(AgentConversationTurnStructureSchema, { userMessage, steps: [mcpStep] }),
        },
      }),
    ),
  );
  sessionStore.set(logicalStoreKey, {
    conversationId: 'conv-tool',
    conversationState: toBinary(
      ConversationStateStructureSchema,
      create(ConversationStateStructureSchema, { turns: [checkpointTurn] }),
    ),
    blobs,
    checkpointUsable: false,
    pendingToolCalls: new Map([
      ['outer-call', 'nested-call'],
      ['outer-still-pending', 'nested-still-pending'],
    ]),
  });
  const model = createCursorLanguageModel('claude-4.5-sonnet', runtimeWith(transport, sessionStore));
  const options = callOptions();
  options.prompt = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'outer-call',
          toolName: 'search',
          output: { type: 'json', value: { matches: 3 } },
        },
      ],
    },
  ];

  const response = await model.doStream(options);
  await lastPartType(response.stream as unknown as ReadableStream<{ type: string }>);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const request = fromBinary(AgentClientMessageSchema, runs[0]![0]!.subarray(5)).message;
  if (request.case !== 'runRequest') throw new Error('expected runRequest');
  expect(request.value.conversationId).toBe('conv-tool');
  expect(request.value.action?.action.case).toBe('resumeAction');
  expect(request.value.conversationState?.turns).toHaveLength(1);

  const stored = sessionStore.get(logicalStoreKey)!;
  const state = fromBinary(ConversationStateStructureSchema, stored.conversationState!);
  const turnBytes = stored.blobs.get(Buffer.from(state.turns[0]!).toString('hex'))!;
  const turn = fromBinary(ConversationTurnStructureSchema, turnBytes);
  if (turn.turn.case !== 'agentConversationTurn') throw new Error('expected agent turn');
  expect(turn.turn.value.userMessage).toEqual(userMessage);
  const stepBytes = stored.blobs.get(Buffer.from(turn.turn.value.steps[0]!).toString('hex'))!;
  const step = fromBinary(ConversationStepSchema, stepBytes);
  if (step.message.case !== 'toolCall' || step.message.value.tool.case !== 'mcpToolCall') {
    throw new Error('expected MCP step');
  }
  expect(step.message.value.tool.value.args?.toolCallId).toBe('nested-call');
  expect(step.message.value.tool.value.result?.result.case).toBe('success');
  expect(step.message.value.tool.value.result?.result.value?.content[0]?.content.value).toMatchObject({
    text: '{"matches":3}',
  });
  expect([...stored.pendingToolCalls]).toEqual([['outer-still-pending', 'nested-still-pending']]);
  expect(stored.checkpointUsable).toBe(false);

  const cleanResponse = await model.doStream(callOptions());
  await lastPartType(cleanResponse.stream as unknown as ReadableStream<{ type: string }>);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect([...sessionStore.get(logicalStoreKey)!.pendingToolCalls]).toEqual([]);
});

test('a failed attempt preserves the prior successful session checkpoint', async () => {
  const sessionStore = new CursorSessionStore();
  const prior = {
    conversationId: 'conv-stable',
    conversationState: toBinary(
      ConversationStateStructureSchema,
      create(ConversationStateStructureSchema, { pendingToolCalls: ['keep'] }),
    ),
    blobs: new Map([['blob', new Uint8Array([1])]]),
    checkpointUsable: true,
    pendingToolCalls: new Map<string, string>(),
  };
  sessionStore.set(logicalStoreKey, prior);
  const transport: CursorTransport = {
    openRun: () =>
      Promise.resolve({
        write: () => {},
        end: () => {},
        frames: (async function* () {
          yield text('partial');
        })(),
        trailers: Promise.resolve({ 'grpc-status': '0' }),
      }),
    unary: () => Promise.reject(new Error('unused')),
  };
  const model = createCursorLanguageModel('claude-4.5-sonnet', runtimeWith(transport, sessionStore));

  const response = await model.doStream(callOptions());
  await expect(lastPartType(response.stream as unknown as ReadableStream<{ type: string }>)).rejects.toThrow(
    /before turnEnded/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(sessionStore.get(logicalStoreKey)).toBe(prior);
});
