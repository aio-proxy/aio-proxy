import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
} from '../../gen/agent_pb';
import type { ConnectFrame } from '../../wire/frame';
import type { CursorTransport } from '../../wire/transport';
import { runCursorTurn } from './driver';

export const serverFrame = (message: Record<string, unknown>): ConnectFrame => ({
  flags: 0,
  payload: toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message } as never)),
});

export const updateFrame = (message: Record<string, unknown>) =>
  serverFrame({ case: 'interactionUpdate', value: { message } });

export async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

export function runHarness(
  overrides: Partial<Omit<Parameters<typeof runCursorTurn>[0], 'transport'>> = {},
  openGate?: Promise<void>,
) {
  const queue: ConnectFrame[] = [];
  const writes: ReturnType<typeof fromClient>[] = [];
  const parts: LanguageModelV4StreamPart[] = [];
  const trailers = Promise.withResolvers<Record<string, string>>();
  let closed = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  let closeCount = 0;
  const notify = () => {
    const next = wake;
    wake = undefined;
    next?.();
  };
  const transport: CursorTransport = {
    unary: async () => {
      throw new Error('unused unary');
    },
    openRun: async () => {
      if (openGate !== undefined) await openGate;
      return {
        write: (bytes) => {
          writes.push(fromClient(bytes));
        },
        end: () => {},
        close: () => {
          closeCount++;
          closed = true;
          trailers.resolve({});
          notify();
        },
        trailers: trailers.promise,
        frames: (async function* () {
          for (;;) {
            if (failure !== undefined) throw failure;
            const frame = queue.shift();
            if (frame !== undefined) {
              yield frame;
              continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
      };
    },
  };
  const turn = runCursorTurn({
    transport,
    accessToken: 'test-token',
    requestBytes: toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {})),
    initialConversationState: create(ConversationStateStructureSchema, {}),
    requestContextTools: [],
    blobStore: new Map(),
    heartbeatMs: 0,
    ...overrides,
  });
  const reader = turn.stream.getReader();
  const drained = (async () => {
    for (;;) {
      const item = await reader.read();
      if (item.done) return parts;
      parts.push(item.value);
    }
  })();
  void drained.catch(() => {});
  void turn.result.catch(() => {});
  return {
    ...turn,
    writes,
    parts,
    drained,
    send(frame: ConnectFrame) {
      queue.push(frame);
      notify();
    },
    eof(values: Record<string, string> = {}) {
      trailers.resolve(values);
      closed = true;
      notify();
    },
    fail(error: unknown) {
      failure = error;
      closed = true;
      trailers.resolve({});
      notify();
    },
    cancel: (reason?: unknown) => reader.cancel(reason),
    closeCount: () => closeCount,
  };
}

function fromClient(bytes: Uint8Array) {
  return fromBinary(AgentClientMessageSchema, bytes.subarray(5)).message;
}
